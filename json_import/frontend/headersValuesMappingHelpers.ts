import {spawnError} from '@airtable/blocks/unstable_private_utils';
import {base} from '@airtable/blocks';
import {fieldTypes} from '@airtable/blocks/models';
import nonblocking from './nonblocking';
import supportedFieldTypes, {fieldConfigByType} from './supportedFieldTypes';
import {setTimeoutAsync} from './setAsyncCommon';
import _ from 'lodash';

function normalizeCellValueForComparison(cellValue) {
    if (typeof cellValue === 'string') {
        return (
            cellValue
                .trim()
                // Hyperbase seems to convert \r\n -> \n
                // Do that as well for incoming data.
                .replace(/\r\n/g, '\n')
        );
    } else if (Array.isArray(cellValue)) {
        return new Set(cellValue);
    } else {
        return cellValue;
    }
}

export function getFieldMappingsMatchingHeaders({parsedHeaders, table}) {
    if (!table) {
        return {};
    }

    const fieldMappingsMatchingHeaders = {};
    for (let index = 0; index < (parsedHeaders || []).length; index++) {
        const header = parsedHeaders[index];
        const fieldMatchingHeader = _.find(table.fields, field => {
            return (
                field.name.toLowerCase() === header.toLowerCase() &&
                _.includes(supportedFieldTypes, field.type)
            );
        });

        if (fieldMatchingHeader) {
            if (fieldMappingsMatchingHeaders.hasOwnProperty(fieldMatchingHeader.id)) {
                // Skip this field if we already found a matching header for it.
                continue;
            }
            fieldMappingsMatchingHeaders[fieldMatchingHeader.id] = {
                isEnabled: true,
                parsedIndex: index,
            };
        }
    }
    return fieldMappingsMatchingHeaders;
}

/**
 * returns {
 *     values: {
 *         [fieldId]: cellValue
 *     }
 *     failures: {
 *         [fieldId]: parsedValue (I think string, whatever parsedRecord is an array of)
 *     }
 * }
 */
export function getValuesAndFailuresByFieldIdForParsedRecord(
    {fieldMappings, parsedHeaders, table},
    parsedRecord,
) {
    if (!table) {
        throw spawnError('Cannot get fields and cell values without a table');
    }

    const cellValueByFieldId = {};
    const failedToMapValueByFieldId = {};
    // TODO: Shouldn't this iterate over fieldMapping instead?
    for (const field of table.fields) {
        if (!_.includes(supportedFieldTypes, field.type)) {
            continue;
        }
        if (!fieldConfigByType[field.type]) {
            throw spawnError(
                'Trying to get cell values using un-supported field type: %s',
                field.type,
            );
        }

        const fieldMapping = fieldMappings[field.id];
        if (fieldMapping && fieldMapping.isEnabled && fieldMapping.parsedIndex !== null) {
            const parsedValue = parsedRecord[fieldMapping.parsedIndex] || '';
            const cellValue = fieldConfigByType[field.type].convertParsedValueToCellValue(
                parsedValue,
                field,
            );
            cellValueByFieldId[field.id] = cellValue;
            if (parsedValue && (cellValue === null || cellValue === undefined)) {
                failedToMapValueByFieldId[field.id] = parsedValue;
            }
        }
    }
    return {
        values: cellValueByFieldId,
        failures: failedToMapValueByFieldId,
    };
}

// predicate for detecting key collisions
// supports composite keys (array)
function createMatcher(fieldIdsForMerging) {
    return (recordDef, record) => {
        return fieldIdsForMerging.reduce((memo, key) => {
            const rdValue = recordDef[key];
            if (!memo || rdValue === null || rdValue === undefined) {
                return false;
            }

            const compValue = normalizeCellValueForComparison(rdValue);
            const cellValue = normalizeCellValueForComparison(record.getCellValue(key));
            return memo && _.isEqual(compValue, cellValue);
        }, true);
    };
}

function isFieldRecordLink(field): boolean {
    return field.type === fieldTypes.MULTIPLE_RECORD_LINKS;
}

export async function createOrUpdateRecordsAsync({table, diff}, onProgress) {
    if (!table) {
        throw spawnError('Cannot create records without a table');
    }

    const recordDefs = _.concat(
        diff.recordDefsToCreate,
        _.map(diff.recordDefsToUpdate, recordDef => recordDef.fields),
    );

    // We need to stay below the 1.9MB request payload limit.
    // TODO: create a batch record create helper in the sdk that actually measures the batch sizes.
    const RECORD_BATCH_SIZE = 50;

    const linkedRecordNamesSetByLinkedTableId = {};
    const linkedTableIdByLinkedRecordFieldId = {};

    for (const recordDef of recordDefs) {
        for (const [fieldId, cellValue] of _.entries(recordDef)) {
            const field = table.getFieldByIdIfExists(fieldId);
            if (!field) {
                throw spawnError('No field');
            }

            if (isFieldRecordLink(field) && cellValue !== null && cellValue !== undefined) {
                // need to create a new record in the linked table
                const {linkedTableId} = field.options;
                if (!linkedRecordNamesSetByLinkedTableId[linkedTableId]) {
                    linkedRecordNamesSetByLinkedTableId[linkedTableId] = new Set();
                }

                // keep track of each cell value that is the name of a linked record
                for (const linkedRecordName of cellValue) {
                    linkedRecordNamesSetByLinkedTableId[linkedTableId].add(linkedRecordName.name);
                }

                // keep track of each linked record field so their cell values can be updated once we know
                // the record id for each linked record
                linkedTableIdByLinkedRecordFieldId[field.id] = linkedTableId;
            }
        }
    }

    const numRecordsToBeTouched =
        recordDefs.length +
        _.reduce(
            linkedRecordNamesSetByLinkedTableId,
            (result, linkedRecordNamesSet) => result + linkedRecordNamesSet.size,
            0,
        );
    let numRecordsTouched = 0;

    // for each linked table, map each name of the linked record to its record id
    const linkedRecordIdByNameByTableId = {};
    for (const [linkedTableId, linkedRecordNamesSet] of _.entries(
        linkedRecordNamesSetByLinkedTableId,
    )) {
        const linkedTable = base.getTableByIdIfExists(linkedTableId);

        if (!linkedTable) {
            continue;
        }
        const linkedTableQueryResult = linkedTable.selectRecords();
        await linkedTableQueryResult.loadDataAsync();

        // keep track of all the records that already exist in the linked table
        linkedRecordIdByNameByTableId[linkedTableId] = {};
        for (const record of linkedTableQueryResult.records) {
            linkedRecordIdByNameByTableId[linkedTableId][record.primaryCellValueAsString] =
                record.id;
        }

        const {primaryField: linkedTablePrimaryField} = linkedTable;
        if (linkedTablePrimaryField.isComputed) {
            // if the field is formulaic/computed, we can't make new records, so don't map these cell values
            numRecordsTouched += linkedRecordNamesSet.size;
            onProgress(numRecordsTouched, numRecordsToBeTouched);
            linkedTableQueryResult.unloadData();
            continue;
        }

        // Do a first pass to figure out how many linked records will just be no-ops (since
        // they already exist).
        // NOTE: this is necessary because calling onProgress in a tight loop makes things really
        // slow. So rather than figuring out which records to no-op as we're also creating records,
        // and calling onProgress every time we no-op, we'll just do one batch to speed things up.
        for (const linkedRecordName of linkedRecordNamesSet) {
            if (linkedRecordIdByNameByTableId[linkedTableId][linkedRecordName]) {
                numRecordsTouched++;
            }
        }
        onProgress(numRecordsTouched, numRecordsToBeTouched);

        // create new records in the linked table for each name that doesn't already exist in the linked table
        let createdLinkedRecordCount = 0;
        for (const linkedRecordName of linkedRecordNamesSet) {
            if (!linkedRecordIdByNameByTableId[linkedTableId][linkedRecordName]) {
                if (!fieldConfigByType[linkedTablePrimaryField.type]) {
                    throw spawnError(
                        'Trying to get linked record values using un-supported field type: %s',
                        linkedTablePrimaryField.type,
                    );
                }

                const recordId = await linkedTable.createRecordAsync({
                    [linkedTable.primaryField.id]: fieldConfigByType[
                        linkedTablePrimaryField.type
                    ].convertParsedValueToCellValue(linkedRecordName, linkedTablePrimaryField),
                });

                linkedRecordIdByNameByTableId[linkedTableId][linkedRecordName] = recordId; // eslint-disable-line require-atomic-updates

                createdLinkedRecordCount++;
                numRecordsTouched++;

                if (createdLinkedRecordCount % RECORD_BATCH_SIZE === 0) {
                    onProgress(numRecordsTouched, numRecordsToBeTouched);
                }
            }
        }
        // Be sure to call onProgress at the end, since we may have been in the middle of
        // a batch, in which case we wouldn't have called onProgress for the last set of
        // records.
        onProgress(numRecordsTouched, numRecordsToBeTouched);

        await setTimeoutAsync(50);
        linkedTableQueryResult.unloadData();
    }

    const tableQueryResult = table.selectRecords();
    await tableQueryResult.loadDataAsync();

    // replace the cell value for each linked record to be the linked record objects json
    for (const recordDef of recordDefs) {
        for (const [linkedRecordFieldId, linkedTableId] of _.entries(
            linkedTableIdByLinkedRecordFieldId,
        )) {
            const linkedRecordCellValue = recordDef[linkedRecordFieldId];
            // Need to _.compact to remove possible nulls.
            // Happens when primary field is read-only, see comment above:
            // "if the field is formulaic/computed, we can't make new records, so don't map these cell values"
            //
            // Also need to remove duplicates with uniqBy, since a linked cell can't contain
            // references to the same record multiple times. This means if the JSON cell has
            // "foo,foo", we remove the second "foo"
            recordDef[linkedRecordFieldId] = _.uniqBy(
                _.compact(
                    linkedRecordCellValue.map(cellValue => {
                        // Check if cellValue has already been updated from {name: ... } to { id: ...}
                        // Happens when updating, if an incoming JSON row matched multiple rows in the table.
                        if (Object.prototype.hasOwnProperty.call(cellValue, 'id')) {
                            return cellValue;
                        } else {
                            const linkedRecordId =
                                linkedRecordIdByNameByTableId[linkedTableId][cellValue.name];
                            return linkedRecordId ? {id: linkedRecordId} : null;
                        }
                    }),
                ),
                cellValue => cellValue.id,
            );
        }
    }

    // update records in batches
    for (let i = 0; i < diff.recordDefsToUpdate.length; i += RECORD_BATCH_SIZE) {
        let initialRecordDefsToUpdate = diff.recordDefsToUpdate.slice(i, i + RECORD_BATCH_SIZE);
        let recordDefsToUpdate = [];
        // get records that were deleted between starting the import process and the persistence step.
        // Move them to the creation list
        for (const recordDef of initialRecordDefsToUpdate) {
            if (tableQueryResult.getRecordById(recordDef.id) === null) {
                diff.recordDefsToCreate.push(recordDef.fields);
            } else {
                recordDefsToUpdate.push(recordDef);
            }
        }

        await table.updateRecordsAsync(recordDefsToUpdate);
        numRecordsTouched += _.size(recordDefsToUpdate);
        onProgress(numRecordsTouched, numRecordsToBeTouched);
    }

    // create records in batches
    for (let i = 0; i < diff.recordDefsToCreate.length; i += RECORD_BATCH_SIZE) {
        const recordDefsToCreate = diff.recordDefsToCreate.slice(i, i + RECORD_BATCH_SIZE);

        await table.createRecordsAsync(recordDefsToCreate);

        numRecordsTouched += recordDefsToCreate.length;
        onProgress(numRecordsTouched, numRecordsToBeTouched);
    }

    tableQueryResult.unloadData();
}

/**
 * Given the input JSON records, field mappings and the merge keys, returns
 * an object with the follow shape:
 *
 * {
 *   recordDefsToCreate: Array<RecordDef>,
 *   recordDefsToUpdate: Array<{fields: RecordDef, id: RecordId}>,
 *   unchangedRecordsById: Array<RecordDef>,
 *   numIgnoredParsedRowsDueToDuplicateMatch: number,
 * }
 *
 * When multiple rows in the JSON file match a record, only the first row will
 * be used and subsequent rows will be ignored. numIgnoredParsedRowsDueToDuplicateMatch
 * is the number of rows that were ignored.
 */
export async function computeDataDiffAsync(
    parsedRecords = [],
    fieldMappings,
    parsedHeaders,
    fieldIdsForMerging,
    table,
    queryResult,
) {
    const tableRecords = queryResult.records;
    // no merge key or empty table, return early, they're all inserts
    if (tableRecords.length === 0 || fieldIdsForMerging.length === 0) {
        const recordDefsToCreate = [];
        const failedToMapValuesByFieldId = {};

        await nonblocking.forEachAsync(parsedRecords, parsedRecord => {
            const valuesAndFailures = getValuesAndFailuresByFieldIdForParsedRecord(
                {fieldMappings, parsedHeaders, table},
                parsedRecord,
            );
            recordDefsToCreate.push(valuesAndFailures.values);
            if (valuesAndFailures.failures) {
                for (const [fieldId, failedToMapValue] of _.entries(valuesAndFailures.failures)) {
                    if (Array.isArray(failedToMapValuesByFieldId[fieldId])) {
                        failedToMapValuesByFieldId[fieldId].push(failedToMapValue);
                    } else {
                        failedToMapValuesByFieldId[fieldId] = [failedToMapValue];
                    }
                }
            }
        });

        return {
            recordDefsToCreate,
            recordDefsToUpdate: [],
            unchangedRecords: [],
            numIgnoredParsedRowsDueToDuplicateMatch: 0,
            failedToMapValuesByFieldId,
        };
    }

    const diff = {
        recordDefsToCreate: [],
        updatesByRecordId: {},
        unchangedRecordsById: {},
        numIgnoredParsedRowsDueToDuplicateMatch: 0,
        failedToMapValuesByFieldId: {},
    };

    const tableRecordsByFirstKeyField = _.groupBy(tableRecords, r => {
        // TODO: for non-primitive fields (e.g. multiple select), this will put
        // all records into a single group with key "[object Object]".
        // We could JSON.stringify, but that would put records with differently
        // ordered options in different groups, which is bad.
        // We should add a Grouper helper to the SDK.
        return normalizeCellValueForComparison(r.getCellValue(fieldIdsForMerging[0]));
    });

    const matcher = createMatcher(fieldIdsForMerging);
    const mappedFieldIds = _.keys(_.pickBy(fieldMappings, fieldMapping => fieldMapping.isEnabled));

    const processedRecordIdsSet = new Set();

    await nonblocking.forEachAsync(parsedRecords, parsedRecord => {
        const {
            values: cellValueByFieldId,
            failures: failedToMapValuesByFieldId,
        } = getValuesAndFailuresByFieldIdForParsedRecord(
            {fieldMappings, parsedHeaders, table},
            parsedRecord,
        );

        for (const [fieldId, failedToMapValue] of _.entries(failedToMapValuesByFieldId)) {
            if (Array.isArray(diff.failedToMapValuesByFieldId[fieldId])) {
                diff.failedToMapValuesByFieldId[fieldId].push(failedToMapValue);
            } else {
                diff.failedToMapValuesByFieldId[fieldId] = [failedToMapValue];
            }
        }

        const firstKeyValue = normalizeCellValueForComparison(
            cellValueByFieldId[fieldIdsForMerging[0]],
        );

        // Only process the JSON record if at least one field is non-null and not an empty array
        if (
            _.some(cellValueByFieldId, (cellValue, fieldId) => {
                return cellValue !== null && !(_.isArray(cellValue) && cellValue.length === 0);
            })
        ) {
            const matchedTableRecords = (tableRecordsByFirstKeyField[firstKeyValue] || []).filter(
                _.partial(matcher, cellValueByFieldId),
            );

            if (matchedTableRecords.length > 0) {
                // Update matching records.
                for (const matchedRecord of matchedTableRecords) {
                    if (processedRecordIdsSet.has(matchedRecord.id)) {
                        // If we've already seen this record before, it means
                        // a prior JSON row matched it. Don't process it again,
                        // and add the parsedRecord to list of ignored rows so we
                        // can tell the user about it.
                        diff.numIgnoredParsedRowsDueToDuplicateMatch++;
                        break;
                    }
                    processedRecordIdsSet.add(matchedRecord.id);

                    const areAnyCellValuesDifferent = _.some(mappedFieldIds, fieldId => {
                        let cellValue = matchedRecord.getCellValue(fieldId);
                        let parsedValue = cellValueByFieldId[fieldId];

                        // if field is a foreign key, compare against the linked record name
                        if (
                            isFieldRecordLink(table.getFieldByIdIfExists(fieldId)) &&
                            _.isArray(cellValue)
                        ) {
                            if (
                                _.isArray(cellValue) &&
                                cellValue.length >= 1 &&
                                (parsedValue === null || parsedValue === undefined)
                            ) {
                                // The cell value is not empty, but the parsed value is.
                                return true;
                            } else if (_.isEmpty(cellValue) && _.isEmpty(parsedValue)) {
                                // both are empty
                                return false;
                            } else {
                                cellValue = cellValue.map(cell => cell.name);
                                parsedValue = parsedValue.map(cell => cell.name);
                            }
                        }

                        cellValue = normalizeCellValueForComparison(cellValue);
                        parsedValue = normalizeCellValueForComparison(parsedValue);

                        return !_.isEqual(parsedValue, cellValue);
                    });

                    if (areAnyCellValuesDifferent) {
                        // Note: if multiple table records match this parsed row, they will share the
                        // same cellValueByFieldId object. Careful when mutating this object.
                        diff.updatesByRecordId[matchedRecord.id] = cellValueByFieldId;
                    } else {
                        diff.unchangedRecordsById[matchedRecord.id] = cellValueByFieldId;
                    }
                }
            } else {
                // No matching records, create a new record.
                diff.recordDefsToCreate.push(cellValueByFieldId);
            }
        }
    });

    diff.recordDefsToUpdate = _.map(diff.updatesByRecordId, (value, key) => ({
        id: key,
        fields: value,
    }));
    delete diff.updatesByRecordId;
    return diff;
}
