import {RecordCard} from '@airtable/blocks/ui';

import {fieldTypes, Table} from '@airtable/blocks/models';
import React from 'react';
import _ from 'lodash';

type RecordPreviewProps = {
    table: Table;
    cellValuesByFieldId: object;
    width: number;
    className: string;
    style: object;
};

class RecordPreview extends React.PureComponent<RecordPreviewProps> {
    render() {
        const {table, cellValuesByFieldId, width, className, style} = this.props;

        // record card currently doesn't support displaying manually specified linked records
        const fieldIds = _.keys(cellValuesByFieldId).filter(fieldId => {
            const field = table.getFieldByIdIfExists(fieldId);
            return field.type !== fieldTypes.MULTIPLE_RECORD_LINKS;
        });
        const fields = fieldIds.map(fieldId => table.getFieldByIdIfExists(fieldId));

        return (
            <RecordCard
                record={cellValuesByFieldId}
                fields={fields}
                width={width}
                className={className}
                style={style}
            />
        );
    }
}

export default RecordPreview;
