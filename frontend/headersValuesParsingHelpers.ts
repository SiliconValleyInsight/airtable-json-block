import * as CSV from 'csv-string';

export function parseHeadersValuesStringSync(parsedString: string) {
    return CSV.parse(parsedString);
}
