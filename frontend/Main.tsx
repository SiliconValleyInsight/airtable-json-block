import {invariant, spawnError} from '@airtable/blocks/unstable_private_utils';
import {base, cursor, globalConfig, session, viewport} from '@airtable/blocks';
import {
    globalAlert,
    Icon,
    colorUtils,
    colors,
    Loader,
    useGlobalConfig,
    useWatchable,
    withHooks,
    initializeBlock,
    Dialog,
} from '@airtable/blocks/ui';
import React, {useRef} from 'react';
import _ from 'lodash';
import FileDropper from './FileDropper';
import SettingsStore, {ConfigKeys} from './SettingsStore';
import ParsedDataReview from './ParsedDataReview';
import {setStateAsync} from './setAsyncCommon';
import {parseJsonFileAsync} from './jsonParsingHelpers';
import {filterJsonAsync} from './jsonFilteringHelpers';
import {parseJsonToHeadersValuesAsync} from './jsonToHeadersValuesParsingHelpers';

// Add the baymax class to the root to use the global baymax styles.
// This was previously the default, but is now opt-in.
invariant(document.body, 'document.body');
document.body.classList.add('baymax');

const FileParseStatuses = {
    WAITING_FOR_FILE: 'waitingForFile',
    ERROR: 'error',
    READING_FILE: 'readingFile',
    REVIEW: 'review',
};

const settingsStore = new SettingsStore();

class Main extends React.Component {
    state = {
        fileParseStatus: FileParseStatuses.WAITING_FOR_FILE,
    };

    constructor(props) {
        super(props);

        this._onBaseTablesChanged = this._onBaseTablesChanged.bind(this);
        this._showReloadPromptIfNeeded = this._showReloadPromptIfNeeded.bind(this);
    }

    componentDidMount() {
        this._showReloadPromptIfNeeded();
    }

    _showReloadPromptIfNeeded() {
        if (settingsStore.isSchemaVersionOutOfDate()) {
            globalAlert.showReloadPrompt();
        }
    }

    // watch for table deletions
    _onBaseTablesChanged() {
        const tableIds = base.tables.map(table => table.id);
        if (this.state.tableId && !tableIds.includes(this.state.tableId)) {
            // if the current table was deleted, switch to a new one
            const newTableId = cursor.activeTableId || base.tables[0].id;
            this.setState({
                tableId: newTableId,
            });
        }
    }

    _onParsedDataReviewClose = settings => {
        const {
            table,
            fieldMappings,
            isFirstLineHeaders,
            shouldMergeDuplicates,
            fieldIdsForMerging,
        } = settings;

        if (table) {
            const tableId = table.id;
            settingsStore.tableId = tableId;
            settingsStore.setFieldMappingsForTableId(tableId, fieldMappings);
            settingsStore.isFirstLineHeaders = isFirstLineHeaders;
            settingsStore.setMergeFieldIdsForTableId(tableId, fieldIdsForMerging);
            settingsStore.shouldMergeDuplicates = shouldMergeDuplicates;
        }

        if (this.state.tempFullscreen && viewport.isFullscreen) {
            viewport.exitFullscreen();
        }

        this.setState({
            fileParseStatus: FileParseStatuses.WAITING_FOR_FILE,
            tempFullscreen: false,
            tableId: null,
        });
    };

    async _processFileAsync(file) {
        await setStateAsync(this, {
            fileParseStatus: FileParseStatuses.READING_FILE,
        });
        const parsedJsonFile = await parseJsonFileAsync(file);
        const parsedData = await parseJsonToHeadersValuesAsync(await filterJsonAsync(_.cloneDeep(parsedJsonFile)));

        // check for errors while parsing
        if (!parsedData) {
            this._showErrorModal('There was an error parsing the JSON file, please try again.');
            return;
        }

        if (parsedData.errors && parsedData.errors.length > 0) {
            const firstError = parsedData.errors[0];
            // If the only error is an undetectable delimiter, process the results as normal, since
            // papaparse defaults to comma-delimiting and correctly parses single-column JSONs.
            const couldBeSingleColumnData =
                parsedData.errors.length === 1 && firstError.code === 'UndetectableDelimiter';
            if (!couldBeSingleColumnData) {
                if (firstError.row) {
                    this._showErrorModal(`
                        The JSON file you uploaded contains an error on row ${firstError.row + 1}
                        ${
                            firstError.message ? `: ${firstError.message}` : ''
                        }. Please fix and try again.
                    `);
                } else {
                    // If there was an error besides an undetectable delimiter, use that instead.
                    const errorMessage =
                        parsedData.errors.length > 1 &&
                        firstError.code === 'UndetectableDelimiter'
                            ? parsedData.errors[1].message
                            : firstError.message;
                    this._showErrorModal(`
                        The JSON file you uploaded contains an error
                        ${errorMessage ? `: ${errorMessage}` : ''}. Please fix and try again.
                    `);
                }
                return;
            }
        }

        if ((parsedJsonFile.data.constructor === Array && parsedJsonFile.data.length === 0) || (Object.keys(parsedJsonFile.data).length === 0 && parsedJsonFile.data.constructor === Object)) {
            this._showErrorModal('The JSON file you uploaded was empty.');
            return;
        }

        if (parsedData.data.length > 15000) {
            this._showErrorModal('The JSON file cannot contain more than 15,000 rows.');
            return;
        }

        // Pull settings store into locally managed state so a user can
        // mess with config without other users messing with their import.
        // We specifically pass the table in as a prop so ParsedDataReview can watch the field configs
        let tableId;
        if (settingsStore.table) {
            tableId = settingsStore.table.id;
        } else if (cursor.activeTableId) {
            tableId = cursor.activeTableId;
        } else {
            tableId = base.tables[0].id;
        }

        const tempFullscreen = !viewport.isFullscreen;
        if (tempFullscreen) {
            viewport.enterFullscreenIfPossible();
        }

        await setStateAsync(this, {
            fileParseStatus: FileParseStatuses.REVIEW,
            parsedData,
            parsedJsonFile,
            tempFullscreen,
            tableId: tableId,
        });
    }

    _onTableChanged = newTable => {
        this.setState({
            tableId: newTable ? newTable.id : null,
        });
    };

    _onPickFile = file => {
        this._processFileAsync(file);
    };

    _onPickFileError = errorMessage => {
        this._showErrorModal(errorMessage);
    };

    _onParsedDataReviewError = errorMessage => {
        this._showErrorModal(errorMessage);
    };

    _showErrorModal(errorMessage) {
        this.setState({
            fileParseStatus: FileParseStatuses.ERROR,
            errorMessage,
        });
    }

    _renderContents() {
        const {fileParseStatus} = this.state;

        switch (fileParseStatus) {
            case FileParseStatuses.WAITING_FOR_FILE:
            case FileParseStatuses.ERROR:
                return (
                    <div className="width-full height-full flex flex-column">
                        <FileDropper
                            onPickFile={this._onPickFile}
                            onError={this._onPickFileError}
                            disabled={settingsStore.isReadOnly}
                            className="flex-auto"
                            fileType="json"
                            mimeTypes={['application/json']}
                            fileTypeFriendlyName="JSON"
                            iconName="json"
                        />
                        {fileParseStatus === FileParseStatuses.ERROR && (
                            <Dialog
                                onClose={() =>
                                    this.setState({
                                        fileParseStatus: FileParseStatuses.WAITING_FOR_FILE,
                                    })
                                }
                                style={{
                                    maxWidth: 350,
                                }}
                            >
                                <div className="relative">
                                    <Dialog.CloseButton className="absolute top-0 right-0 mr1 mt1 pointer link-quiet" />
                                    <div className="p2">
                                        <div className="flex items-center mb2">
                                            <Icon
                                                name="warning"
                                                size={18}
                                                fillColor={colorUtils.getHexForColor(colors.ORANGE)}
                                            />
                                            <span className="huge strong ml1">
                                                Sorry, something is wrong
                                            </span>
                                        </div>
                                        <div className="big">{this.state.errorMessage}</div>
                                    </div>
                                </div>
                            </Dialog>
                        )}
                    </div>
                );

            case FileParseStatuses.READING_FILE:
                return (
                    <div className="width-full height-full flex items-center justify-center">
                        <div className="p2 flex flex-column items-center justify-center">
                            <span className="mb1 strong quiet">Reading file...</span>
                            <Loader />
                        </div>
                    </div>
                );

            case FileParseStatuses.REVIEW: {
                const {parsedData, parsedJsonFile, tableId} = this.state;
                if (!parsedData) {
                    throw spawnError('No parsed data for review state');
                }

                const table = tableId ? base.getTableByIdIfExists(tableId) : null;
                if (!table) {
                    throw spawnError('Cannot render parsed data review state without a table');
                }

                return (
                    <ParsedDataReview
                        parsedData={parsedData}
                        parsedJsonFile={parsedJsonFile}
                        settingsStore={settingsStore}
                        onClose={this._onParsedDataReviewClose}
                        onError={this._onParsedDataReviewError}
                        className="width-full height-full"
                        table={table}
                        onTableChanged={this._onTableChanged}
                    />
                );
            }

            default:
                throw spawnError('Unrecognized status: %s', fileParseStatus);
        }
    }
    render() {
        return <div className="absolute all-0">{this._renderContents()}</div>;
    }
}

const Block = withHooks(Main, () => {
    const instanceRef = useRef();
    useWatchable(session, 'permissionLevel');

    useWatchable(base, 'tables', () => {
        instanceRef.current._onBaseTablesChanged();
    });

    useGlobalConfig();
    useWatchable(globalConfig, ConfigKeys.schemaVersion, () => {
        instanceRef.current._showReloadPromptIfNeeded();
    });

    useWatchable(cursor, 'activeTableId');

    return {
        ref: instanceRef,
    };
});

initializeBlock(() => <Block />);
