import {spawnError} from '@airtable/blocks/unstable_private_utils';

import {Table, TableOrViewQueryResult} from '@airtable/blocks/models';
import {Icon, colorUtils, colors} from '@airtable/blocks/ui';
import React from 'react';
import {AutoSizer, List} from 'react-virtualized';
import _ from 'lodash';

import RecordPreview from './RecordPreview';

const MAX_ROWS_PER_TABLE = 50000;
const RECORD_CARD_HEIGHT = 80;
const RECORD_CARD_MARGIN = 16;
const RECORD_LIST_HEADER_HEIGHT = 48;

type RecordPreviewListProps = {
    table: Table;
    queryResult: TableOrViewQueryResult;
    failedToMapValuesByFieldId: object;
    dataDiff: object;
};

export default class RecordPreviewList extends React.Component<RecordPreviewListProps> {
    listRef = React.createRef();

    recomputeRowHeights() {
        if (this.listRef.current) {
            this.listRef.current.recomputeRowHeights();
        }
    }

    _renderRecordPreview(cellValuesByFieldId, index, width) {
        const {table} = this.props;

        if (!table) {
            throw spawnError('Cannot render parsed record without a table');
        }

        return (
            <RecordPreview
                key={index}
                table={table}
                cellValuesByFieldId={cellValuesByFieldId}
                width={width}
                style={{marginTop: 2}}
            />
        );
    }

    _renderTableRecordNumberExceededMessage(remainingRecordLimit) {
        return (
            <div className="absolute all-0 flex flex-column items-center justify-center p2 quiet">
                <h3 className="mb1 strong">Table record limit exceeded</h3>
                <div className="big center">
                    {`The JSON file has too many records to import. You can import at most
                    ${remainingRecordLimit} record${remainingRecordLimit === 1 ? '' : 's'}.`}
                </div>
            </div>
        );
    }

    _renderNoUpdatesOrInsertsMessage() {
        return (
            <div className="absolute all-0 flex flex-column items-center justify-center p2 quiet">
                <h3 className="mb1 strong">No new or updated records found</h3>
                <div className="big center">
                    Based on the current field mappings, all rows in this JSON file are already in
                    the selected table
                </div>
            </div>
        );
    }

    render() {
        const {queryResult, failedToMapValuesByFieldId, dataDiff: diff} = this.props;
        if (!queryResult.isDataLoaded) {
            return null;
        }

        if (!diff) {
            return null;
        }

        const numRecordsToCreate = diff.recordDefsToCreate.length;
        // TODO(ben): Use recordLimit when it's back in the sdk
        const remainingRecords = MAX_ROWS_PER_TABLE - queryResult.records.length;
        if (numRecordsToCreate > remainingRecords) {
            return (
                <div className="height-full flex flex-column">
                    <div className="flex-none" />
                    <div className="flex-auto relative">
                        {this._renderTableRecordNumberExceededMessage(remainingRecords)}
                    </div>
                </div>
            );
        }

        const items = [];

        if (numRecordsToCreate > 0) {
            items.push(
                `${numRecordsToCreate} record${numRecordsToCreate > 1 ? 's' : ''} will be created`,
                ...diff.recordDefsToCreate,
            );
        }
        const numRecordsToUpdate = diff.recordDefsToUpdate.length;
        if (numRecordsToUpdate > 0) {
            items.push(
                `${numRecordsToUpdate} record${numRecordsToUpdate > 1 ? 's' : ''}  will be updated`,
                ..._.map(diff.recordDefsToUpdate, recordDef => recordDef.fields),
            );
        }
        const numRecordsUnchanged = _.size(diff.unchangedRecordsById);
        if (numRecordsUnchanged > 0) {
            items.push(
                `${numRecordsUnchanged} record${numRecordsUnchanged > 1 ? 's' : ''}  didn't change`,
                ..._.values(diff.unchangedRecordsById),
            );
        }

        const warnings = [];
        const ignoredCount = diff.numIgnoredParsedRowsDueToDuplicateMatch;
        if (ignoredCount > 0) {
            const text =
                ignoredCount === 1
                    ? '1 row in the JSON file was ignored because it had duplicate values in the merge field.'
                    : `${ignoredCount} rows in the JSON file were ignored because they had duplicate values in the merge field.`;
            warnings.push(
                <div
                    key="ignoredRows"
                    className="p2 line-height-4 quiet border-bottom-thick border-darken1 flex items-center"
                >
                    <Icon
                        name="warning"
                        fillColor={colorUtils.getHexForColor(colors.YELLOW_BRIGHT)}
                        className="mr1"
                    />
                    {text}
                </div>,
            );
        }

        const failedToMapValues = _.flatten(_.values(failedToMapValuesByFieldId));
        if (failedToMapValues.length > 0) {
            warnings.push(
                <div
                    key="failedToMap"
                    className="p2 line-height-4 quiet border-bottom-thick border-darken1 flex items-center"
                >
                    <Icon
                        name="warning"
                        fillColor={colorUtils.getHexForColor(colors.YELLOW_BRIGHT)}
                        className="mr1"
                    />
                    {failedToMapValues.length} cell value
                    {failedToMapValues.length === 1 ? ' ' : 's '}
                    couldn
                    {"'"}t be mapped.
                </div>,
            );
        }

        const noUpdatesOrInserts =
            diff && diff.recordDefsToCreate.length === 0 && diff.recordDefsToUpdate.length === 0;
        const recordPreviews = noUpdatesOrInserts ? (
            this._renderNoUpdatesOrInsertsMessage()
        ) : (
            <AutoSizer>
                {({height, width}) => (
                    <List
                        className="light-scrollbar no-outline"
                        rowCount={items.length}
                        rowHeight={({index}) => {
                            return typeof items[index] === 'string'
                                ? RECORD_LIST_HEADER_HEIGHT
                                : RECORD_CARD_HEIGHT + RECORD_CARD_MARGIN;
                        }}
                        overscanRowCount={10}
                        rowRenderer={({index, key, style}) => {
                            const item = items[index];
                            if (typeof item === 'string') {
                                return (
                                    <div key={key} className="huge strong p2 quiet" style={style}>
                                        {item}
                                    </div>
                                );
                            } else {
                                return (
                                    <div className="px2" key={key} style={style}>
                                        {this._renderRecordPreview(
                                            item,
                                            index,
                                            width - RECORD_CARD_MARGIN * 2,
                                        )}
                                    </div>
                                );
                            }
                        }}
                        height={height}
                        width={width}
                        ref={this.listRef}
                    />
                )}
            </AutoSizer>
        );

        return (
            <div className="height-full flex flex-column">
                <div className="flex-none">{warnings}</div>
                <div className="flex-auto relative">{recordPreviews}</div>
            </div>
        );
    }
}
