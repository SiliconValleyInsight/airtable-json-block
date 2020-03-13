import Papa from 'papaparse';

export async function parseJsonToHeadersValuesAsync({data}) {
  let parsedData;

  const parseDataPromise = new Promise((resolve, reject) => {
    try {
      parsedData = Papa.parse(Papa.unparse(data));
      resolve();
    } catch (error) {
      console.error(error);
      resolve();
    }
  });

  await parseDataPromise;

  return parsedData;
}
