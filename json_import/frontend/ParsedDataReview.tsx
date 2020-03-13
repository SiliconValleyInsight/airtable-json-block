import {spawnError, trackEvent} from '@airtable/blocks/unstable_private_utils';
import {viewport} from '@airtable/blocks';
import {fieldTypes, Table} from '@airtable/blocks/models';
import {
    TablePicker,
    Tooltip,
    Select,
    Icon,
    Input,
    colorUtils,
    colors,
    Button,
    Modal,
    Loader,
    ProgressBar,
    ViewportConstraint,
    useBase,
    useViewport,
    useWatchable,
    withHooks,
    Switch,
} from '@airtable/blocks/ui';
import React, {useRef} from 'react';
import jp from 'jsonpath';
import FieldMapping from './FieldMapping';
import RecordPreviewList from './RecordPreviewList';
import supportedFieldTypes, {
    fieldConfigByType,
    filterDeletedOrUnsupportedFieldIds,
    getLinkedTablesPrimaryFieldTypesByTableId,
    isFieldValid,
} from './supportedFieldTypes';
import {
    getFieldMappingsMatchingHeaders,
    createOrUpdateRecordsAsync,
    computeDataDiffAsync,
} from './headersValuesMappingHelpers';
import {setStateAsync, setTimeoutAsync} from './setAsyncCommon';
import _ from 'lodash';
import classNames from 'classnames';
import {filterJsonAsync} from './jsonFilteringHelpers';
import {parseJsonToHeadersValuesAsync} from './jsonToHeadersValuesParsingHelpers';

const MAX_ROWS_PER_TABLE = 50000;

const ReviewStatuses = {
    REVIEW: 'review',
    FAILED_TO_MAP_VALUES: 'failedToMapValues',
    CREATING_RECORDS: 'creatingRecords',
    SUCCESS: 'success',
};

type ParsedDataReviewProps = {
    parsedData: object;
    parsedJsonFile: object;
    settingsStore: object;
    onClose: (settings: object) => void;
    onError: (errorMessage: string) => void;
    table: Table;
    onTableChanged: (newTable: object) => void;
    className: string;
    style: object;
};

type ParsedDataReviewState = {
    status: string;
    parsedData: object;
    fieldMappings: object;
    parsedRecords: Array<object>;
    parsedHeaders: Array<string>;
    isFirstLineHeaders: boolean;
    shouldMergeDuplicates: boolean;
    fieldIdsForMerging: Array<number>;
    dataDiff: object;
    isDataDiffReady: boolean;
};

class ParsedDataReview extends React.Component<ParsedDataReviewProps, ParsedDataReviewState> {
    recordPreviewListRef = React.createRef();

    constructor(props: ParsedDataReviewProps) {
        super(props);

        const {parsedData, settingsStore, table} = props;
        this.state = this._getIcState(parsedData, settingsStore, table);

        // This id is used to ensure that we don't store stale loads. It is implemented as a strictly increasing counter.
        // Whenever we finish computing a dataDiff, we check that the counter hasn't changed.
        // If it hasn't, it is safe to store the result. If it has increased, we don't store the result and
        // continue to wait on the new computation (which caused the counter to increase).
        // We never reset the counter as that would break the invariant.
        this._dataDiffId = 0;
        this._onTableFieldsChange = this._onTableFieldsChange.bind(this);
        this._onFieldConfigChange = this._onFieldConfigChange.bind(this);
        this._computeJsonPathAsync = _.debounce(this._computeJsonPathAsync, 300);
    }

    _getIcState = (parsedData, settingsStore, table) => {
      const {data} = parsedData;
      if (!data || !data.length) {
        return {
                 status: ReviewStatuses.REVIEW,
                 fieldMappings: settingsStore.getFieldMappingsForTableId(table.id),
                 isFirstLineHeaders: true,
               };
      }

      const parsedFirstLine = data[0];

      const fieldMappings = settingsStore.getFieldMappingsForTableId(table.id);

      // Use stored config if every field mapping has an index within the bounds of this parsed file.
      const isUsingStoredConfig = _.every(fieldMappings, fieldMapping => {
          return (
              fieldMapping.parsedIndex === null ||
              (fieldMapping.parsedIndex >= 0 && fieldMapping.parsedIndex < (parsedFirstLine || []).length)
          );
      });

      const fieldIdsForMerging = settingsStore.getMergeFieldIdsForTableId(table.id);

      const shouldMergeDuplicates = settingsStore.shouldMergeDuplicates;
      const fieldMappingsMatchingHeaders = getFieldMappingsMatchingHeaders({
          parsedHeaders: parsedFirstLine,
          table,
      });

      // Let's determine if any field names match the parsed header names. If they do, we'll pre-populate
      // the appropriate field mappings and assume isFirstLineHeaders === true
      let isFirstLineHeaders;
      if (_.keys(fieldMappingsMatchingHeaders).length > 0) {
          _.each(fieldMappingsMatchingHeaders, (fieldMapping, fieldId) => {
              if (!fieldMappings.hasOwnProperty(fieldId)) {
                  fieldMappings[fieldId] = fieldMapping;
              }
          });
          isFirstLineHeaders = true;
      } else {
          isFirstLineHeaders = isUsingStoredConfig ? settingsStore.isFirstLineHeaders : false;
      }

      const {parsedRecords, parsedHeaders} = this._getParsedRecordsAndParsedHeaders(parsedData, isFirstLineHeaders);

      const state = {
          status: ReviewStatuses.REVIEW,
          parsedData,
          fieldMappings,
          parsedRecords,
          parsedHeaders,
          isFirstLineHeaders,
          shouldMergeDuplicates,
          fieldIdsForMerging,
          dataDiff: null,
          isDataDiffReady: false,
      };

      return state;
    }

    componentDidMount() {
        this._loadTableDataAsync(this.props.table);
    }

    componentWillUnmount() {
        if (this.state.queryResult) {
            this.state.queryResult.unloadData();
        }
    }

    _onFieldMappingChange = (fieldId, newIndex) => {
        const {fieldMappings} = this.state;

        const fieldMapping = {
            ...fieldMappings[fieldId],
        };
        fieldMapping.parsedIndex = newIndex;

        this.setState(
            {
                fieldMappings: {
                    ...fieldMappings,
                    [fieldId]: fieldMapping,
                },
            },
            this._computeDataDiffAsync,
        );
    };

    _computeJsonPathAsync = async () => {
      const {parsedJsonFile} = this.props;
      const {jsonPath} = this.state;

      if (!jsonPath || jsonPath === '') {
        await this._setStateFromParsedJsonFileAsync(parsedJsonFile);
        return;
      }

      const extractedJsonData = {};
      try {
        extractedJsonData.data = jp.query(parsedJsonFile.data, jsonPath);
      } catch (error) {
        await this._setStateFromParsedJsonFileAsync({data: []});
        return;
      }
      extractedJsonData.data = [].concat(...extractedJsonData.data);

      if (!(extractedJsonData.data || {}).length) {
        await this._setStateFromParsedJsonFileAsync({data: []});
        return;
      }

      await this._setStateFromParsedJsonFileAsync(extractedJsonData);
    };

    _setStateFromParsedJsonFileAsync = async (parsedJsonFile) => {
      const {isFirstLineHeaders} = this.state;

      const parsedData = await parseJsonToHeadersValuesAsync(await filterJsonAsync(_.cloneDeep(parsedJsonFile)));
      const {parsedRecords, parsedHeaders} = this._getParsedRecordsAndParsedHeaders(parsedData, isFirstLineHeaders);

      this.setState(
          {
            parsedData,
            parsedHeaders: parsedHeaders || [],
            parsedRecords,
          },
          this._computeDataDiffAsync,
      );
    }


    _computeDataDiffAsync = async () => {
        const {
            fieldMappings,
            fieldIdsForMerging,
            shouldMergeDuplicates,
            parsedHeaders,
            parsedRecords,
            queryResult,
        } = this.state;
        const newDataDiffId = this._dataDiffId + 1;
        this._dataDiffId = newDataDiffId;

        // TODO: cancel existing load? Debounce? Memoize?
        this.setState({
            dataDiff: null,
            isDataDiffReady: false,
        });
        const newDataDiff = await computeDataDiffAsync(
            parsedRecords,
            fieldMappings,
            parsedHeaders,
            shouldMergeDuplicates ? fieldIdsForMerging : [],
            this.props.table,
            queryResult,
        );

        // Store the load only if another load wasn't queued up in the meantime
        if (newDataDiffId === this._dataDiffId) {
            this.setState({
                isDataDiffReady: true,
                dataDiff: newDataDiff,
            });
        }
        return newDataDiff;
    };

    // TODO: refactor this component to not use getDerivedStateFromProps
    static getDerivedStateFromProps(props, state) {
        const {fieldMappings, fieldIdsForMerging, status, queryResult} = state;
        const {table} = props;

        // Bail out early from getDerivedStateFromProps if an import is in progress.
        // We do this to avoid recalculation of dataDiff (an expensive operation) as
        // records get created/updated
        // Note: getDerivedStateFromProps gets when status === ReviewStatuses.CREATING_RECORDS
        // because the `progress` state property gets updated during creation/update.
        if (status === ReviewStatuses.CREATING_RECORDS) {
            return null;
        }

        // TODO: Do we really want to do this filtering here? Can we just have the right listeners
        // and do the filtering then? In general, handling schema changes while the block is running
        // is super annoying to have to think about

        // Filter out possibly deleted or unsupported fields from the merge key and
        // mapping config keys
        const filteredFieldIdsForMerging = filterDeletedOrUnsupportedFieldIds(
            fieldIdsForMerging,
            table,
        );

        const filteredFieldMappings = _.pick(
            fieldMappings,
            filterDeletedOrUnsupportedFieldIds(_.keys(fieldMappings), table),
        );

        // if table is still not loaded, empty the `dataDiff` state variable to prevent
        // using stale data (eg, a diff from a previously selected table).
        return queryResult && queryResult.isDataLoaded
            ? {
                  fieldMappings: filteredFieldMappings,
                  fieldIdsForMerging: filteredFieldIdsForMerging,
              }
            : // I believe queryResult not being loaded implies that we're in the middle of _loadTableDataAsync and will
              // therefore call _computeDataDiffAsync in the setState callback when we finish awaiting the queryResult
              // loading, so we should not get stuck with no dataDiff.
              {
                  isDataDiffReady: false,
                  dataDiff: null,
              };
    }

    _onTableFieldsChange() {
        // Recompute the dataDiff, since our fields changed.
        this._computeDataDiffAsync();
    }

    _onFieldConfigChange(field) {
        const {fieldMappings} = this.state;
        const {table} = this.props;

        const fieldMapping = fieldMappings[field.id];
        if (fieldMapping && fieldMapping.isEnabled) {
            if (isFieldValid(field, getLinkedTablesPrimaryFieldTypesByTableId(table))) {
                if (fieldMapping.parsedIndex !== null) {
                    // only need to recompute dataDiff if the field is actually enabled
                    this._computeDataDiffAsync();
                }
            } else {
                // Field type has become invalid, so disable the mapping altogether.
                const newFieldMappings = {
                    ...fieldMappings,
                    [field.id]: {
                        isEnabled: false,
                        parsedIndex: null,
                    },
                };

                this.setState(
                    {
                        fieldMappings: newFieldMappings,
                    },
                    this._computeDataDiffAsync,
                );
            }
        }
    }

    _onClose = () => {
        const settings = {
            ...this.state,
            table: this.props.table,
        };
        this.props.onClose(settings);
    };

    _onCloseModal = () => {
        this.setState({
            status: ReviewStatuses.REVIEW,
        });
    };

    _getDefaultHeaders() {
        const {parsedData} = this.state;
        const {data} = parsedData;

        return _.range(data[0].length).map(index => `Column ${index + 1}`);
    }

    _validate() {
        const {table} = this.props;
        if (!table) {
            return {
                isValid: false,
                message: 'Pick a table',
            };
        }

        const {fieldMappings, fieldIdsForMerging, shouldMergeDuplicates} = this.state;
        const enabledFieldMappings = _.filter(_.values(fieldMappings), _.property('isEnabled'));

        if (
            enabledFieldMappings.length === 0 ||
            _.every(enabledFieldMappings, fieldMapping => fieldMapping.parsedIndex === null)
        ) {
            return {
                isValid: false,
                message: 'Map at least one JSON column to a field',
            };
        }

        if (shouldMergeDuplicates && fieldIdsForMerging.length === 0) {
            return {
                isValid: false,
                message: 'Choose a field to match existing records for merging',
            };
        }

        if (
            shouldMergeDuplicates &&
            !_.every(fieldIdsForMerging, fieldId => {
                const fieldMapping = fieldMappings[fieldId];
                return fieldMapping && fieldMapping.isEnabled && fieldMapping.parsedIndex !== null;
            })
        ) {
            return {
                isValid: false,
                message: 'Map the merge field to a JSON column',
            };
        }

        for (const field of table.fields) {
            const fieldMapping = fieldMappings[field.id];
            if (fieldMapping && fieldMapping.isEnabled && fieldMapping.parsedIndex === null) {
                return {
                    isValid: false,
                    message: `Map a JSON column to the "${field.name}" field for merging`,
                };
            }
        }

        // This needs to be the last check in this method: we need to validate field mappings
        // before checking field and table locks
        if (!this._canUserPerformImport()) {
            return {
                isValid: false,
                message: "You don't have permissions to import to the selected fields",
            };
        }

        return {isValid: true};
    }

    _onCreateWithFailedToMapValues = () => {
        this.setState({
            status: ReviewStatuses.FAILED_TO_MAP_VALUES,
        });
    };

    async _loadTableDataAsync(table) {
        const {queryResult} = this.state;

        if (queryResult) {
            queryResult.unloadData();
        }
        const newQueryResult = table.selectRecords();
        await newQueryResult.loadDataAsync();
        this.setState(
            {
                queryResult: newQueryResult,
                dataDiff: null,
                isDataDiffReady: false,
            },
            this._computeDataDiffAsync,
        );
    }

    // All callers should check that the dataDiff is ready before calling this method.
    _createOrUpdateRecordsAsync = async () => {
        const {dataDiff, isDataDiffReady} = this.state;
        if (!dataDiff || !isDataDiffReady) {
            throw spawnError('Data diff is not ready');
        }

        const startTime = Date.now();
        await setStateAsync(this, {
            status: ReviewStatuses.CREATING_RECORDS,
            progress: 0,
        });

        const {table} = this.props;
        if (!table) {
            throw spawnError('Cannot create records without a table');
        }

        const {queryResult} = this.state;
        if (!queryResult.isDataLoaded) {
            await queryResult.loadDataAsync();
        }

        // make sure there is still a valid number of records remaining in the table to create all the records from the parsed
        // TODO(ben): Use recordLimit when it's back in the sdk
        const remainingRecords = MAX_ROWS_PER_TABLE - queryResult.records.length;
        if (remainingRecords < dataDiff.recordDefsToCreate.length) {
            this.props.onError(
                `The JSON file has too many records to import. You can import at most ${remainingRecords} more record${
                    remainingRecords === 1 ? '' : 's'
                }.`,
            );
            return;
        }

        await createOrUpdateRecordsAsync(
            {
                table,
                diff: dataDiff,
            },
            this._onProgress,
        );

        await setStateAsync(this, {status: ReviewStatuses.SUCCESS});

        const durationMs = Date.now() - startTime;
        this._trackImport(durationMs);

        await setTimeoutAsync(1500);

        if (viewport.isFullscreen) {
            viewport.exitFullscreen();
        }

        this._onClose();
    };

    _trackImport(durationMs) {
        const fieldMappings = this.state.table
            ? this.props.settingsStore.getFieldMappingsForTableId(this.state.table.id)
            : {};
        const numFieldMappings = Object.values(fieldMappings).filter(
            fieldMapping => fieldMapping.isEnabled,
        ).length;

        trackEvent('blockInstallation.jsonImport.import', {
            isMerging: this.state.shouldMergeDuplicates,
            durationMs,
            isFirstLineHeaders: this.state.isFirstLineHeaders,
            numFieldMappings,
        });
    }

    _onProgress = (numRecordsTouched, numRecordsToBeTouched) => {
        const progress = numRecordsTouched / numRecordsToBeTouched;
        this.setState({progress});
    };

    _onTableChange = newTable => {
        this.props.onTableChanged(newTable);

        const {data} = this.state.parsedData;
        const parsedFirstLine = data[0];

        const fieldMappingsMatchingHeaders = getFieldMappingsMatchingHeaders({
            parsedHeaders: parsedFirstLine,
            table: newTable,
        });
        const foundFieldNamesWithHeaders = _.keys(fieldMappingsMatchingHeaders).length > 0;

        const fieldMappings = this.props.settingsStore.getFieldMappingsForTableId(newTable.id);
        const fieldIdsForMerging = this.props.settingsStore.getMergeFieldIdsForTableId(newTable.id);

        let isFirstLineHeaders;
        if (foundFieldNamesWithHeaders) {
            _.each(fieldMappingsMatchingHeaders, (fieldMapping, fieldId) => {
                if (!fieldMappings.hasOwnProperty(fieldId)) {
                    fieldMappings[fieldId] = fieldMapping;
                }
            });
            isFirstLineHeaders = true;
        } else {
            isFirstLineHeaders = this.state.isFirstLineHeaders;
        }

        const {parsedRecords, parsedHeaders} = this._getParsedRecordsAndParsedHeaders(this.state.parsedData, isFirstLineHeaders);

        this.setState(
            {
                fieldMappings,
                isFirstLineHeaders,
                fieldIdsForMerging,
                parsedRecords,
                parsedHeaders,
                dataDiff: null,
                isDataDiffReady: false,
            },
            () => {
                this._loadTableDataAsync(newTable);
            },
        );
    };

    _getParsedRecordsAndParsedHeaders(parsedData, isFirstLineHeaders) {
        const {data} = parsedData;

        let parsedRecords;
        let parsedHeaders;
        if (isFirstLineHeaders) {
            parsedRecords = data.slice();
            parsedHeaders = parsedRecords.shift(1);
        } else {
            parsedRecords = data;
            parsedHeaders = this._getDefaultHeaders();
        }

        return {parsedRecords, parsedHeaders};
    }

    _onMergeDuplicatesToggleChange = shouldMergeDuplicates => {
        this.setState(
            {
                shouldMergeDuplicates,
            },
            this._computeDataDiffAsync,
        );
    };

    _onJsonPathChange = e => {
        this.setState(
            {
                jsonPath: (e.target || {}).value,
            },
            this._computeJsonPathAsync,
        );
    };

    _onSelectedKeyForMergingChange = (keyIndex, fieldId) => {
        const {fieldIdsForMerging} = this.state;

        // TODO: don't mutate state directly
        fieldIdsForMerging[keyIndex] = fieldId;
        this.setState(
            {
                fieldIdsForMerging: fieldIdsForMerging,
            },
            this._computeDataDiffAsync,
        );
        if (this.recordPreviewListRef.current) {
            this.recordPreviewListRef.current.recomputeRowHeights();
        }
    };

    _onFieldMappingToggle = fieldId => {
        const {fieldMappings} = this.state;

        const newFieldMappings = {
            ...fieldMappings,
        };
        const fieldMapping = newFieldMappings[fieldId] || {
            isEnabled: false,
            parsedIndex: null,
        };
        const isEnabled = !fieldMapping.isEnabled;
        fieldMapping.isEnabled = isEnabled;
        newFieldMappings[fieldId] = fieldMapping;

        this.setState(
            {
                fieldMappings: newFieldMappings,
            },
            this._computeDataDiffAsync,
        );
    };

    _onFieldMappingChange = (fieldId, newIndex) => {
        const {fieldMappings} = this.state;

        const fieldMapping = {
            ...fieldMappings[fieldId],
        };
        fieldMapping.parsedIndex = newIndex;

        this.setState(
            {
                fieldMappings: {
                    ...fieldMappings,
                    [fieldId]: fieldMapping,
                },
            },
            this._computeDataDiffAsync,
        );
    };

    _canUserPerformImport() {
        const {dataDiff: diff, isDataDiffReady} = this.state;
        if (!isDataDiffReady || !diff) {
            return true;
        }
        const {table} = this.props;
        // TODO: ideally we wouldn't need to do the below map. Hopefully a new sdk will change this api
        const rv =
            table.hasPermissionToCreateRecords(
                _.map(diff.recordDefsToCreate, recordDef => ({fields: recordDef})),
            ) && table.hasPermissionToUpdateRecords(diff.recordDefsToUpdate);
        return rv;
    }

    _renderFieldMappings() {
        const {table} = this.props;
        if (!table) {
            return null;
        }

        const {fieldMappings, parsedHeaders} = this.state;

        const supportedFields = [];
        const unsupportedFields = [];
        for (const field of table.fields) {
            if (_.includes(supportedFieldTypes, field.type)) {
                supportedFields.push(field);
            } else {
                unsupportedFields.push(field);
            }
        }

        const fieldMappingElements = [...supportedFields, ...unsupportedFields].map(field => {
            const {isEnabled, parsedIndex} = fieldMappings[field.id] || {
                isEnabled: false,
                parsedIndex: null,
            };

            return (
                <FieldMapping
                    key={field.id}
                    field={field}
                    parsedHeaders={parsedHeaders || []}
                    selectedIndex={parsedIndex}
                    onChange={newHeaderIndex =>
                        this._onFieldMappingChange(field.id, newHeaderIndex)
                    }
                    isEnabled={isEnabled}
                    onToggle={() => this._onFieldMappingToggle(field.id)}
                    isFieldTypeSupported={isFieldValid(
                        field,
                        getLinkedTablesPrimaryFieldTypesByTableId(table),
                    )}
                />
            );
        });

        return (
            <div className="mt2">
                <div className="strong quiet mb1 big">Field mappings</div>
                <div className="border-bottom-thick border-darken1">{fieldMappingElements}</div>
            </div>
        );
    }

    _renderJsonPathRootObjectNoArrayMessage() {
        return (
            <div className="flex flex-column items-center">
                <h3 className="mb1 strong">Select a different file or Set up JSONPath</h3>
                <div className="big center">
                    The selected file does not contain a top-level Array. Select a different file or use JSONPath.
                </div>
                <a className="big center" href="https://jsonpath.com/" target="_new" >jsonpath.com</a>
            </div>
        );
    }

    _renderJsonPathNoMatchMessage() {
        return (
            <div className="flex flex-column items-center">
                <h3 className="mb1 strong">Set up JSONPath</h3>
                <div className="big center">
                    JSONPath expression has no matches.
                </div>
                <a className="big center" href="https://jsonpath.com/" target="_new">jsonpath.com</a>
            </div>
        );
    }

    _renderAllFieldMappingsDisabledMessage() {
        return (
            <div className="flex flex-column items-center">
                <h3 className="mb1 strong">Set up field mappings</h3>
                <div className="big center">
                    Choose how you'd like to map each JSON column to the fields in the "
                    {this.props.table.name}" table.
                </div>
            </div>
        );
    }

    _renderRightPane() {
        const {table} = this.props;
        if (!table) {
            return null;
        }

        const validationResult = this._validate();
        const isConfigValid = validationResult.isValid;
        const {fieldMappings, queryResult, jsonPath, parsedHeaders} = this.state;
        const areAllFieldMappingsDisabled = _.every(
            fieldMappings,
            fieldMapping =>
                !fieldMapping || fieldMapping.parsedIndex === null || !fieldMapping.isEnabled,
        );
        const isJsonPathNoMatch = !(!jsonPath || jsonPath === '') && !(parsedHeaders && parsedHeaders.length);
        const isJsonPathNoArray = (!jsonPath || jsonPath === '') && !(parsedHeaders && parsedHeaders.length);

        let rightPane;
        let containerClasses = 'flex-auto flex items-center justify-center p2 huge quiet';

        if (this.state.status === ReviewStatuses.CREATING_RECORDS) {
            rightPane = <h3 className="mb1 strong">Saving records…</h3>;
        } else if (!this.state.isDataDiffReady) {
            rightPane = <h3 className="mb1 strong">Loading…</h3>;
        } else if (isConfigValid && queryResult && (parsedHeaders && parsedHeaders.length) && !isJsonPathNoArray) {
            containerClasses = 'flex-auto';

            rightPane = (
                <RecordPreviewList
                    table={table}
                    queryResult={queryResult}
                    dataDiff={this.state.dataDiff}
                    failedToMapValuesByFieldId={this.state.dataDiff.failedToMapValuesByFieldId}
                    ref={this.recordPreviewListRef}
                />
            );
        } else if (areAllFieldMappingsDisabled) {
            rightPane = this._renderAllFieldMappingsDisabledMessage();
        } else if (isJsonPathNoMatch) {
            rightPane = this._renderJsonPathNoMatchMessage();
        } else if (isJsonPathNoArray) {
            rightPane = this._renderJsonPathRootObjectNoArrayMessage();
        } else {
            rightPane = <h3 className="mb1 strong">{validationResult.message}</h3>;
        }

        return <div className={containerClasses}>{rightPane}</div>;
    }

    _renderFieldMappingsAndRecordPreviewsForTable() {
        const {table} = this.props;
        const {shouldMergeDuplicates} = this.state;
        const sideBarWidth = viewport.size.width * 0.4;

        return (
            <div className="flex-auto flex overflow-hidden">
                <div
                    className="p2 flex-none overflow-auto light-scrollbar border-right-thick border-darken1"
                    style={{width: sideBarWidth}}
                >
                    <div className="strong quiet mb1 big">Table</div>
                    <TablePicker
                        table={table}
                        onChange={this._onTableChange}
                        className="width-full"
                    />
                    <div className="mt3">
                        <div className="strong quiet pb1 mb1 big border-bottom-thick border-darken1">
                            Options
                        </div>
                        <Switch
                            onChange={this._onMergeDuplicatesToggleChange}
                            value={shouldMergeDuplicates}
                            label="Merge with existing records"
                        />
                        {shouldMergeDuplicates && (
                            <div className="mt1 mb2">
                                <div className="line-height-4 quiet">
                                    JSON rows will be merged if they match the following field:
                                </div>
                                <Select
                                    value={this.state.fieldIdsForMerging[0]}
                                    options={[
                                        {
                                            value: undefined,
                                            label: 'Choose a field...',
                                            disabled: true,
                                        },
                                        ...table.fields
                                            .filter(field =>
                                                _.includes(supportedFieldTypes, field.type),
                                            )
                                            // We're punting on supporting linked fields as the merge key for now.
                                            .filter(
                                                field =>
                                                    field.type !== fieldTypes.MULTIPLE_RECORD_LINKS,
                                            )
                                            .map(field => ({
                                                value: field.id,
                                                label: field.name,
                                            })),
                                    ]}
                                    label="Select key field"
                                    onChange={_.partial(this._onSelectedKeyForMergingChange, 0)}
                                    className="width-full mt1"
                                />
                            </div>
                        )}
                      <br/>

                      <div className="strong quiet mb-half mt2 flex items-center">
                      <div className="mr-half">JSONPath</div>
                      <Tooltip className="nowrap" content="What is JSONPath?">
                          <a className="pointer link-quiet" href="https://jsonpath.com/" target="_new">
                              <Icon
                                  name="help"
                                  size={10}
                                  fillColor={colorUtils.getHexForColor(colors.GRAY_BRIGHT)}
                              />
                          </a>
                      </Tooltip>
                      </div>
                      <Input
                          value={this.state.jsonPath}
                          type="text"
                          placeholder="Enter a JSONPath expression..."
                          onChange={this._onJsonPathChange}
                          className="width-full"
                          style={{border: 0}}
                      />

                    </div>
                    <div className="mt3">{this._renderFieldMappings()}</div>
                </div>
                {this._renderRightPane()}
            </div>
        );
    }

    _getStatusBarText() {
        let statusBarText = '';

        const {isDataDiffReady, dataDiff, queryResult} = this.state;
        if (!isDataDiffReady || !dataDiff || !queryResult || !queryResult.isDataLoaded) {
            return null;
        }

        // TODO(ben): Use recordLimit when it's back in the sdk
        const remainingRecords = MAX_ROWS_PER_TABLE - queryResult.records.length;
        if (dataDiff.recordDefsToCreate.length > remainingRecords) {
            return 'Table record limit exceeded.';
        }

        if (dataDiff.recordDefsToCreate.length > 0) {
            statusBarText += `${dataDiff.recordDefsToCreate.length} record${
                dataDiff.recordDefsToCreate.length > 1 ? 's' : ''
            } will be created.`;
        }

        const updatesCount = dataDiff.recordDefsToUpdate.length;
        if (updatesCount > 0) {
            statusBarText += ` ${updatesCount} record${
                updatesCount > 1 ? 's' : ''
            } will be updated.`;
        }

        const unchangedCount = _.size(dataDiff.unchangedRecordsById);
        if (unchangedCount > 0) {
            statusBarText += ` ${unchangedCount} record${
                unchangedCount > 1 ? 's' : ''
            } didn't change.`;
        }

        return statusBarText;
    }

    _renderBottomBar() {
        const {isDataDiffReady, dataDiff, queryResult} = this.state;
        if (!isDataDiffReady || !queryResult || !queryResult.isDataLoaded) {
            return null;
        }

        const willCreateOrUpdateRecords = dataDiff
            ? dataDiff.recordDefsToCreate.length > 0 || dataDiff.recordDefsToUpdate.length > 0
            : false;
        // TODO(ben): Use recordLimit when it's back in the sdk
        const remainingRecords = MAX_ROWS_PER_TABLE - queryResult.records.length;
        const tableRecordLimitExceeded = dataDiff
            ? remainingRecords < dataDiff.recordDefsToCreate.length
            : false;
        const validationResult = this._validate();
        const failedToMapValues = _.flatten(_.values(dataDiff.failedToMapValuesByFieldId));

        return (
            <div className="flex-none flex items-center justify-between p2 border-top-thick border-darken1">
                {validationResult.isValid ? (
                    <div>{this._getStatusBarText()}</div>
                ) : (
                    <div className="flex-none flex items-center">
                        <Icon
                            name="warning"
                            fillColor={colorUtils.getHexForColor(colors.YELLOW_BRIGHT)}
                            className="mr1"
                        />{' '}
                        {validationResult.message}
                    </div>
                )}
                <div>
                    <Button onClick={this._onClose} variant="secondary" style={{border: 0}}>
                        Cancel
                    </Button>
                    <Button
                        className="ml1"
                        onClick={
                            validationResult.isValid
                                ? failedToMapValues.length > 0
                                    ? this._onCreateWithFailedToMapValues
                                    : this._createOrUpdateRecordsAsync
                                : undefined
                        }
                        disabled={
                            !validationResult.isValid ||
                            tableRecordLimitExceeded ||
                            !willCreateOrUpdateRecords ||
                            !this._canUserPerformImport()
                        }
                        variant="primary"
                        style={{border: 0}}
                    >
                        Save records
                    </Button>
                </div>
            </div>
        );
    }

    _renderModal() {
        const {status} = this.state;
        const {table} = this.props;

        let modalContents;
        switch (status) {
            case ReviewStatuses.REVIEW:
                return null;

            case ReviewStatuses.FAILED_TO_MAP_VALUES: {
                const {isDataDiffReady, dataDiff} = this.state;
                if (!isDataDiffReady) {
                    modalContents = (
                        <div className="flex flex-column justify-center width-full height-full relative">
                            <h3 className="mb1 strong">Loading…</h3>
                            <div className="right-align">
                                <Button
                                    onClick={this._onCloseModal}
                                    variant="secondary"
                                    style={{border: 0}}
                                >
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    );
                    break;
                }

                const {failedToMapValuesByFieldId} = dataDiff;
                const failedToMapValues = _.flatten(_.values(failedToMapValuesByFieldId));

                if (failedToMapValues.length > 0) {
                    modalContents = (
                        <div className="flex flex-column justify-center width-full height-full relative">
                            <h3 className="mb1 strong quiet">
                                The following values won't be imported:
                            </h3>
                            <div className="mb1 strong quiet small">
                                All other values will be imported if you continue.
                            </div>
                            {_.map(failedToMapValuesByFieldId, (values, fieldId) => {
                                if (values.length === 0) {
                                    return null;
                                } else {
                                    const field = table.getFieldByIdIfExists(fieldId);
                                    const {helpMessage} = fieldConfigByType[field.type];
                                    return (
                                        <div key={fieldId} className="py1">
                                            <div className="strong">{field.name}</div>
                                            {helpMessage && (
                                                <div className="quieter strong small">
                                                    {helpMessage}
                                                </div>
                                            )}
                                            <div className="py1">
                                                {_.map(_.uniq(values), (value, index) => (
                                                    <div
                                                        className="small mb-half truncate"
                                                        key={index}
                                                    >
                                                        {value}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                }
                            })}
                            <div className="right-align">
                                <Button
                                    onClick={this._onCloseModal}
                                    variant="secondary"
                                    style={{border: 0}}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    onClick={this._createOrUpdateRecordsAsync}
                                    variant="primary"
                                    className="ml1"
                                    style={{border: 0}}
                                >
                                    Continue
                                </Button>
                            </div>
                        </div>
                    );
                } else {
                    modalContents = (
                        <div className="flex flex-column justify-center width-full height-full relative">
                            <div className="strong quiet">All conversion issues fixed!</div>
                            <div className="right-align">
                                <Button
                                    onClick={this._onCloseModal}
                                    variant="secondary"
                                    style={{border: 0}}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    onClick={this._createOrUpdateRecordsAsync}
                                    variant="primary"
                                    className="ml1"
                                    style={{border: 0}}
                                >
                                    Continue
                                </Button>
                            </div>
                        </div>
                    );
                }
                break;
            }

            case ReviewStatuses.CREATING_RECORDS:
                modalContents = (
                    <div className="flex flex-column justify-center width-full height-full">
                        <div className="mb1 strong quiet self-center">Saving records</div>
                        <div className="self-center mb1">
                            <Loader />
                        </div>
                        <ProgressBar progress={this.state.progress} />
                    </div>
                );
                break;

            case ReviewStatuses.SUCCESS:
                modalContents = (
                    <div className="flex flex-column items-center justify-center width-full height-full">
                        <div className="mb1 strong quiet">Success!</div>
                        <Icon
                            name="check"
                            size={40}
                            fillColor={colorUtils.getHexForColor(colors.GREEN_BRIGHT)}
                        />
                    </div>
                );
                break;

            default:
                throw spawnError('Unrecognized review status: ', status);
        }

        return (
            <Modal
                className="p2"
                style={{
                    maxWidth: 450,
                }}
            >
                {modalContents}
            </Modal>
        );
    }

    render() {
        const {className, style} = this.props;

        return (
            <ViewportConstraint minSize={{width: 800, height: 250}}>
                <div className={classNames('flex flex-column', className)} style={style}>
                    <div className="flex flex-column flex-auto overflow-hidden">
                        {this._renderFieldMappingsAndRecordPreviewsForTable()}
                    </div>
                    {this._renderBottomBar()}
                    {this._renderModal()}
                </div>
            </ViewportConstraint>
        );
    }
}

export default withHooks(ParsedDataReview, (props: ParsedDataReviewProps) => {
    const instanceRef = useRef();

    // We need to useBase to get field lock changes, which also triggers for the specific field
    // watches. Should we just get rid of them? This also triggers on linked record field changes
    useBase();
    useViewport();

    useWatchable(props.table, 'fields', () => {
        instanceRef.current._onTableFieldsChange();
    });

    useWatchable(props.table.fields, ['type', 'options'], field => {
        instanceRef.current._onFieldConfigChange(field);
    });

    return {
        ref: instanceRef,
    };
});
