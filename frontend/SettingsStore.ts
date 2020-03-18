import {base, globalConfig} from '@airtable/blocks';
import _ from 'lodash';
import {filterDeletedOrUnsupportedFieldIds} from './supportedFieldTypes';

export const SCHEMA_VERSION = 2;

export const ConfigKeys = {
    schemaVersion: 'schemaVersion',
    tableId: 'tableId',
    fieldMappingsByTableId: 'fieldMappingsByTableId',
    isFirstLineHeaders: 'isFirstLineHeaders',
    shouldMergeDuplicates: 'shouldMergeDuplicates',
    mergeFieldIdsByTableId: 'mergeFieldIdsByTableId',
};

class SettingsStore {
    constructor() {
        Object.freeze(this);
        const storedSchemaVersion = globalConfig.get(ConfigKeys.schemaVersion);
        if (!this.isReadOnly) {
            // We check against a specific schema version since we wipe on migration.
            // We should migrate data when upgrading schema versions in the future.
            if (!storedSchemaVersion || storedSchemaVersion < 2) {
                globalConfig.setAsync(ConfigKeys.schemaVersion, SCHEMA_VERSION);
                // We used to store null which is unsupported and could cause crashes.
                // We also had multiple different formats before schema version 2, so we ended up
                // wiping the data instead of migrating it.
                globalConfig.setAsync(ConfigKeys.fieldMappingsByTableId, undefined);
            }
        }
    }

    get isReadOnly() {
        return !globalConfig.hasPermissionToSet(ConfigKeys.schemaVersion);
    }

    get tableId() {
        return globalConfig.get(ConfigKeys.tableId);
    }

    set tableId(tableId) {
        globalConfig.setAsync(ConfigKeys.tableId, tableId);
    }

    get table() {
        const tableId = this.tableId;
        return tableId ? base.getTableByIdIfExists(tableId) : null;
    }

    get isFirstLineHeaders() {
        return globalConfig.get(ConfigKeys.isFirstLineHeaders) || true;
    }

    set isFirstLineHeaders(isFirstLineHeaders) {
        globalConfig.setAsync(ConfigKeys.isFirstLineHeaders, isFirstLineHeaders);
    }

    get shouldMergeDuplicates() {
        return globalConfig.get(ConfigKeys.shouldMergeDuplicates) || false;
    }

    set shouldMergeDuplicates(shouldMergeDuplicates) {
        globalConfig.setAsync(ConfigKeys.shouldMergeDuplicates, shouldMergeDuplicates);
    }

    /**
     * I believe this returns [FieldId]
     * Which doesn't make a lot of sense since we only allow merging on one field
     */
    getMergeFieldIdsForTableId(tableId) {
        const mergeFieldIds = globalConfig.get([ConfigKeys.mergeFieldIdsByTableId, tableId]);
        return filterDeletedOrUnsupportedFieldIds(
            mergeFieldIds,
            base.getTableByIdIfExists(tableId),
        );
    }

    setMergeFieldIdsForTableId(tableId, fieldIds) {
        globalConfig.setAsync([ConfigKeys.mergeFieldIdsByTableId, tableId], fieldIds);
    }

    isSchemaVersionOutOfDate() {
        return globalConfig.get(ConfigKeys.schemaVersion) > SCHEMA_VERSION;
    }

    /**
     * Returns {
     *   [key: FieldId]: {
     *     isEnabled: boolean,
     *     parsedIndex: number | null,
     *   }
     * }
     */
    getFieldMappingsForTableId(tableId) {
        const fieldMappings = globalConfig.get([ConfigKeys.fieldMappingsByTableId, tableId]) || {};
        const validFieldIds = filterDeletedOrUnsupportedFieldIds(
            _.keys(fieldMappings),
            base.getTableByIdIfExists(tableId),
        );
        return _.pick(fieldMappings, validFieldIds);
    }

    setFieldMappingsForTableId(tableId, fieldMappings) {
        globalConfig.setAsync([ConfigKeys.fieldMappingsByTableId, tableId], fieldMappings);
    }
}

export default SettingsStore;
