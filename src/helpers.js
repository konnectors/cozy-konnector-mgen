const { cozyClient, log } = require('cozy-konnector-libs')

const fetchAll = async doctype => {
  try {
    const result = await cozyClient.fetchJSON(
      'GET',
      `/data/${doctype}/_all_docs?include_docs=true`
    )
    const rows = result.rows
    return rows.filter(x => x.id.indexOf('_design') !== 0).map(x => x.doc)
  } catch (e) {
    if (e && e.response && e.response.status && e.response.status === 404) {
      return []
    } else {
      log('error', e)
      return []
    }
  }
}

const updateAll = async (doctype, docs) => {
  return cozyClient.fetchJSON('POST', `/data/${doctype}/_bulk_docs`, { docs })
}

const lsDir = async folder => {
  const limit = 100000
  const folderId = folder._id
  const data = await cozyClient.fetchJSON(
    'GET',
    `/files/${folderId}?page[limit]=${limit}`,
    null,
    {
      processJSONAPI: false
    }
  )
  return data.included
}

module.exports = {
  fetchAll,
  updateAll,
  lsDir
}
