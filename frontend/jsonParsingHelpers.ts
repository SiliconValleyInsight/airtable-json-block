export async function parseJsonFileAsync(file: File) {
  let parsedJsonData;

  const parseJsonPromise = new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      parsedJsonData = {};
      parsedJsonData.data = JSON.parse(event.target.result);
      resolve();
    };

    reader.onerror = () => {
      console.error(reader.error);
      reader.abort();
      parsedJsonData = null;
      resolve();
    };

    reader.readAsText(file);
  });

  await parseJsonPromise;

  return parsedJsonData;
}
