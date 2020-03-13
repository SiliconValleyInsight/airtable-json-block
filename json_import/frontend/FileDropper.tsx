import {viewport} from '@airtable/blocks';
import {useWatchable, withHooks} from '@airtable/blocks/ui';
import React from 'react';
import classNames from 'classnames';
import _ from 'lodash';
import JsonImage from './JsonImage';

type FileDropperProps = {
    onPickFile: (file: File) => void;
    onError: (errorMessage: string) => void;
    disabled: boolean;
    className: string;
    style: object;
    fileType: string;
    fileTypeFriendlyName: string;
    mimeTypes: Array<string>;
    iconName: string;
    learnMoreUrl: string;
};

type FileDropperState = {
    isMousingOver: boolean;
    isDraggingOver: boolean;
};

class FileDropper extends React.Component<FileDropperProps, FileDropperState> {
    _fileInput: HTMLInputElement;

    state = {
        isMousingOver: false,
        isDraggingOver: false,
    };

    _onManualFileInputClick = () => {
        this._fileInput.click();
    };

    _onFileInputChange = e => {
        const {onPickFile} = this.props;

        const file = e.target.files[0];
        if (file && onPickFile) {
            onPickFile(file);
        }
    };

    _onMouseOver = () => {
        this.setState({
            isMousingOver: true,
        });
    };

    _onMouseOut = () => {
        this.setState({
            isMousingOver: false,
        });
    };

    _onDragOver = e => {
        e.preventDefault();
    };

    _onDragEnter = () => {
        this.setState({
            isDraggingOver: true,
        });
    };

    _onDragLeave = () => {
        this.setState({
            isDraggingOver: false,
        });
    };

    _onDrop = e => {
        const {disabled, fileTypeFriendlyName, onError, onPickFile} = this.props;

        e.preventDefault();
        e.stopPropagation();

        this.setState({
            isDraggingOver: false,
        });

        // If disabled, do nothing, but we still want to respond to this event
        // to prevent the default behavior.
        if (disabled) {
            return;
        }

        const {files} = e.dataTransfer;
        if (files.length > 1) {
            if (onError) {
                onError('You can only upload one file at a time.');
            }
            return;
        }

        const file = files.item(0);
        if (!this._isFileValid(file)) {
            if (onError) {
                onError(`You must upload a ${fileTypeFriendlyName} file.`);
            }
            return;
        }

        if (onPickFile) {
            onPickFile(file);
        }
    };

    _isFileValid(file) {
        const {fileType, mimeTypes} = this.props;

        let allTypes = [];
        if (mimeTypes) {
            allTypes = allTypes.concat(mimeTypes);
        }
        if (fileType) {
            allTypes.push(fileType);
        }

        // Check both the mimetype and the file extension.
        // This fixes a drag and drop bug on Windows.
        const fileExtension = file.name
            .split('.')
            .pop()
            .toLowerCase();

        return _.includes(allTypes, file.type) || _.includes(allTypes, fileExtension);
    }

    render() {
        const {disabled, fileType, fileTypeFriendlyName, mimeTypes} = this.props;

        const isMousingOrDraggingOverAndNotDisabled =
            (this.state.isMousingOver || this.state.isDraggingOver) && !disabled;

        const fileText = fileTypeFriendlyName ? `${fileTypeFriendlyName} file` : 'file';

        return (
            <div
                className={classNames(
                    'rounded-big p2 flex flex-column items-center justify-center',
                    this.props.className,
                )}
                style={this.props.style}
            >
                <div
                    className={classNames(
                        'flex-auto self-stretch flex flex-column items-center justify-center',
                        {
                            'pointer link-quiet': !disabled,
                            quieter: disabled,
                        },
                    )}
                    onClick={!disabled && this._onManualFileInputClick}
                    onMouseOver={this._onMouseOver}
                    onMouseOut={this._onMouseOut}
                    onDragOver={this._onDragOver}
                    onDragEnter={this._onDragEnter}
                    onDragLeave={this._onDragLeave}
                    onDrop={this._onDrop}
                >
                    <input
                        type="file"
                        className="hide"
                        ref={el => (this._fileInput = el)}
                        accept={`.${fileType},${mimeTypes.join(',')}`}
                        onChange={this._onFileInputChange}
                    />
                    {viewport.size.height > 150 && (
                        <JsonImage
                            height={!isMousingOrDraggingOverAndNotDisabled ? 48 : 64}
                            width={!isMousingOrDraggingOverAndNotDisabled ? 48 : 64}
                            fill={!isMousingOrDraggingOverAndNotDisabled ? '#555555' : '#270046'}
                        />
                    )}
                    <div className="noevents center huge strong mb-half" style={{paddingTop: 32}}>
                        Drop a {fileText} to import
                    </div>
                    <div className="noevents center strong quiet">Or click to choose a file...</div>
                </div>
                {this.props.learnMoreUrl && (
                    <a
                        onClick={e => e.stopPropagation()}
                        href={this.props.learnMoreUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-none mt2 p1 rounded small text-blue darken1-hover"
                    >
                        Learn more
                    </a>
                )}
            </div>
        );
    }
}

export default withHooks(FileDropper, () => {
    useWatchable(viewport, 'size');
    return {};
});
