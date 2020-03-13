import {base} from '@airtable/blocks';
import {fieldTypes} from '@airtable/blocks/models';
import _ from 'lodash';
import {parseHeadersValuesStringSync} from './headersValuesParsingHelpers';

const supportedFieldTypes = [
    fieldTypes.SINGLE_LINE_TEXT,
    fieldTypes.EMAIL,
    fieldTypes.URL,
    fieldTypes.MULTILINE_TEXT,
    fieldTypes.NUMBER,
    fieldTypes.CURRENCY,
    fieldTypes.PERCENT,
    fieldTypes.SINGLE_SELECT,
    fieldTypes.MULTIPLE_SELECTS,
    fieldTypes.SINGLE_COLLABORATOR,
    fieldTypes.MULTIPLE_COLLABORATORS,
    fieldTypes.MULTIPLE_RECORD_LINKS,
    fieldTypes.DATE,
    fieldTypes.DATE_TIME,
    fieldTypes.PHONE_NUMBER,
    fieldTypes.CHECKBOX,
    fieldTypes.RATING,
    fieldTypes.DURATION,
];

const supportedFieldTypesForLinkedTablePrimaryField = [
    ...supportedFieldTypes,
    fieldTypes.FORMULA,
    fieldTypes.AUTO_NUMBER,
];

export const fieldConfigByType = {
    [fieldTypes.SINGLE_LINE_TEXT]: {
        key: fieldTypes.SINGLE_LINE_TEXT,
        convertParsedValueToCellValue,
    },
    [fieldTypes.EMAIL]: {
        key: fieldTypes.EMAIL,
        convertParsedValueToCellValue,
    },
    [fieldTypes.URL]: {
        key: fieldTypes.URL,
        convertParsedValueToCellValue,
    },
    [fieldTypes.MULTILINE_TEXT]: {
        key: fieldTypes.MULTILINE_TEXT,
        convertParsedValueToCellValue,
    },
    [fieldTypes.NUMBER]: {
        key: fieldTypes.NUMBER,
        convertParsedValueToCellValue,
    },
    [fieldTypes.CURRENCY]: {
        key: fieldTypes.CURRENCY,
        convertParsedValueToCellValue,
    },
    [fieldTypes.PERCENT]: {
        key: fieldTypes.PERCENT,
        convertParsedValueToCellValue,
    },
    [fieldTypes.SINGLE_SELECT]: {
        key: fieldTypes.SINGLE_SELECT,
        convertParsedValueToCellValue,
        helpMessage: 'Create new select options to import these values',
    },
    [fieldTypes.MULTIPLE_SELECTS]: {
        key: fieldTypes.MULTIPLE_SELECTS,
        convertParsedValueToCellValue,
        helpMessage: 'Create new select options to import these values',
    },
    [fieldTypes.SINGLE_COLLABORATOR]: {
        key: fieldTypes.SINGLE_COLLABORATOR,
        convertParsedValueToCellValue,
        helpMessage: 'Invite missing collaborators to import these values',
    },
    [fieldTypes.MULTIPLE_COLLABORATORS]: {
        key: fieldTypes.MULTIPLE_COLLABORATORS,
        convertParsedValueToCellValue,
        helpMessage: 'Invite missing collaborators to import these values',
    },
    [fieldTypes.MULTIPLE_RECORD_LINKS]: {
        key: fieldTypes.MULTIPLE_RECORD_LINKS,
        convertParsedValueToCellValue: (parsedValue, field) => {
            // this returns the primary field value for the new linked records, since the actual records may not exist already

            // Replace line breaks with spaces before attempting to parse this field as a JSON row.
            // Allowing it to contain newlines would produce > 1 rows.
            if (typeof parsedValue === 'string') {
                parsedValue = parsedValue.replace(/(\r\n|\n|\r)/gm, ' ');
            }
            const parseResult = parseHeadersValuesStringSync(parsedValue);
            if (parseResult.length !== 1) {
                // Temporary logging
                console.log('parseResult', JSON.stringify(parseResult));
                throw Error(`parseResult.length must be 1. Value is: ${parseResult.length}`);
            }

            const parsedRow = parseResult[0];
            if (parsedRow === '') {
                return null;
            } else {
                return _.compact(
                    parsedRow.map(cell => {
                        return cell.trim() !== '' ? {name: cell.trim()} : null;
                    }),
                );
            }
        },
    },
    [fieldTypes.DATE]: {
        key: fieldTypes.DATE,
        convertParsedValueToCellValue,
    },
    [fieldTypes.DATE_TIME]: {
        key: fieldTypes.DATE_TIME,
        convertParsedValueToCellValue,
    },
    [fieldTypes.PHONE_NUMBER]: {
        key: fieldTypes.PHONE_NUMBER,
        convertParsedValueToCellValue,
    },
    [fieldTypes.CHECKBOX]: {
        key: fieldTypes.CHECKBOX,
        convertParsedValueToCellValue,
    },
    [fieldTypes.RATING]: {
        key: fieldTypes.RATING,
        convertParsedValueToCellValue: (parsedValue, field) => {
            // Special case zero: convertStringToCellValue will return
            // null which gets treated as a "failedToMap" value.
            if (parsedValue === '0') {
                return 0;
            } else {
                return convertParsedValueToCellValue(parsedValue, field);
            }
        },
    },
    [fieldTypes.DURATION]: {
        key: fieldTypes.DURATION,
        convertParsedValueToCellValue,
    },
};

function convertParsedValueToCellValue(parsedValue, field) {
    if (parsedValue) {
        return field.convertStringToCellValue(parsedValue);
    } else {
        return null;
    }
}

export function isFieldValid(field, linkedTablesPrimaryFieldTypesByTableId = null): boolean {
    if (field === null) {
        return false;
    }

    if (!linkedTablesPrimaryFieldTypesByTableId) {
        linkedTablesPrimaryFieldTypesByTableId = getLinkedTablesPrimaryFieldTypesByTableId(
            field.parentTable,
        );
    }
    return (
        !!field &&
        (field.type === fieldTypes.MULTIPLE_RECORD_LINKS
            ? _.includes(
                  supportedFieldTypesForLinkedTablePrimaryField,
                  linkedTablesPrimaryFieldTypesByTableId[field.options.linkedTableId],
              )
            : _.includes(supportedFieldTypes, field.type))
    );
}

/**
 * I believe:
 * fieldIds?: [FieldId]
 * table: Table
 * return [FieldId]
 */
export const filterDeletedOrUnsupportedFieldIds = (fieldIds, table) => {
    return (fieldIds || []).filter(fieldId => {
        const field = table.getFieldByIdIfExists(fieldId);
        return isFieldValid(field);
    });
};

export function getLinkedTablesPrimaryFieldTypesByTableId(table) {
    return _.fromPairs(
        table.fields
            .filter(field => field.type === fieldTypes.MULTIPLE_RECORD_LINKS)
            .map(field => [
                field.options.linkedTableId,
                base.getTableByIdIfExists(field.options.linkedTableId).primaryField.type,
            ]),
    );
}

export default supportedFieldTypes;
