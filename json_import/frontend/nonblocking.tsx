// Copied from the chart block. Ideally we'd be able to share code between blocks
/* helper functions for iterating over an array without blocking the UI thread */
const BUDGET_MS = 10;

const schedule = (callback: () => void) => window.requestAnimationFrame(callback);

async function forEachAsync<T>(
    array: Array<T>,
    callback: (value: T, index: number, array: Array<T>) => unknown,
): Promise<void> {
    await new Promise((resolve, reject) => {
        let i = 0;
        const len = array.length;

        const step = () => {
            const stepEnd = Date.now() + BUDGET_MS;
            while (i < len && Date.now() < stepEnd) {
                try {
                    callback(array[i], i, array);
                } catch (err) {
                    reject(err);
                    return;
                }
                i += 1;
            }

            if (i >= len) {
                resolve();
            } else {
                schedule(step);
            }
        };

        schedule(step);
    });
}

async function mapAsync<T, U>(
    array: Array<T>,
    callback: (item: T, index: number, array: Array<T>) => U,
): Promise<Array<U>> {
    let results: Array<U> = [];
    await forEachAsync(array, (item, i, arr) => {
        results.push(callback(item, i, arr));
    });
    return results;
}

export default {
    forEachAsync,
    mapAsync,
};
