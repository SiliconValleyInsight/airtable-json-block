export async function filterJsonAsync({data}) {
  let filteredJsonData;

  const filterJsonPromise = new Promise((resolve, reject) => {
    try {
      filteredJsonData = {};
      filteredJsonData.data = filterArrays(data);
      resolve();
    } catch (error) {
      console.error(error);
      resolve();
    }
  });

  await filterJsonPromise;

  return filteredJsonData;
}

export const filterArrays = (data) => {
  if (!Array.isArray(data)) {
    return data;
  }
  return data.map((item) => {
    if (Array.isArray(item)) {
      return item;
    }
    Object.keys(item).forEach((key) => {
      const value = item[key];
      if (Array.isArray(value)) { // if value is an array of objects
        if (value.length > 0 && typeof value[1] === 'object' && value[1] !== null) {
          delete item[key];
        }
      } else if (typeof value === 'object' && value !== null) { // if value is an object
        delete item[key];
      }
    });
    return item;
  });
};
