import {viewport} from '@airtable/blocks';
import {
    Tooltip,
    Icon,
    Select,
    useViewport,
    useWatchable,
    withHooks,
    Switch,
} from '@airtable/blocks/ui';
import React from 'react';

import classNames from 'classnames';

type FieldMappingProps = {
    field: object;
    parsedHeaders: Array<string>;
    selectedIndex: number;
    onChange: (newHeaderIndex: number) => void;
    isEnabled: (isEnabled: boolean) => void;
    onToggle: () => void;
    className: string;
    style: object;
    isFieldTypeSupported: boolean;
};

class FieldMapping extends React.Component<FieldMappingProps, {}> {
    render() {
        const {
            parsedHeaders,
            selectedIndex,
            isEnabled,
            onToggle,
            field,
            onChange,
            className,
            style,
            isFieldTypeSupported,
        } = this.props;
        const toggleWidth = viewport.size.width * 0.4 * 0.33;

        return (
            <div
                className={classNames(
                    'border-top-thick border-darken1 py1 flex items-center',
                    className,
                )}
                style={{
                    height: 50,
                    ...style,
                }}
            >
                <Tooltip
                    className="nowrap"
                    disabled={isFieldTypeSupported}
                    content="This field type is not supported"
                >
                    <div
                        className="width-full"
                        style={{
                            width: toggleWidth,
                            minWidth: 114,
                        }}
                    >
                        <Switch
                            disabled={!isFieldTypeSupported}
                            onChange={onToggle}
                            value={isEnabled}
                            label={
                                <div className="textOverflowEllipsis width-full no-user-select">
                                    {field.name}
                                </div>
                            }
                            className="p1 flex-none width-full"
                        />
                    </div>
                </Tooltip>
                {isEnabled && <Icon name="left" className="flex-none mx2 text-gray" />}
                {isEnabled && (
                    <div className="inline-block flex-auto">
                        <Select
                            value={selectedIndex}
                            options={[
                                {value: undefined, label: 'Choose a JSON column', disabled: true},
                                ...parsedHeaders.map((parsedHeader, index) => ({
                                    value: index,
                                    label: parsedHeader,
                                })),
                            ]}
                            onChange={onChange}
                            className="width-full"
                        />
                    </div>
                )}
            </div>
        );
    }
}

export default withHooks(FieldMapping, (props: FieldMappingProps) => {
    useViewport();
    useWatchable(props.field, ['type', 'options']);
    return {};
});
