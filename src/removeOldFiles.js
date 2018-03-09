const { cozyClient, log } = require('cozy-konnector-libs')
const bluebird = require('bluebird')

const oldNameFormat = /\d{4}\d{2}_mgen\.pdf/
const isOldFile = file => {
  return oldNameFormat.exec(file.attributes.name)
}

const lsDir = async folder => {
  const limit = 100000
  const folderId = folder._id
  const data = await cozyClient.fetchJSON('GET', `/files/${folderId}?page[limit]=${limit}`, null, {
    processJSONAPI: false
  })
  return data.included
}

const removeOldFiles = async fields => {
  const folder = await cozyClient.files.statByPath(fields.folderPath)
  const files = await lsDir(folder)
  const oldMgenFiles = files.filter(isOldFile)
  log('info', `Found ${oldMgenFiles.length} old MGEN files`)
  return bluebird.map(oldMgenFiles, file => {
    log('info', `Deleting file ${file.attributes.name}`)
    return cozyClient.files.destroyById(file.id)
  }, { concurrency: 5 })
}

module.exports = removeOldFiles
