export async function setStateAsync(context, partialState) {
    return new Promise((resolve, reject) => {
        context.setState(partialState, () => {
            resolve();
        });
    });
}

export async function setTimeoutAsync(timeout) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, timeout);
    });
}
