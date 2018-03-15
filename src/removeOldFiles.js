const { cozyClient, log } = require('cozy-konnector-libs')
const bluebird = require('bluebird')
const Promise = bluebird.Promise
const { first, sortBy, keyBy } = require('lodash')
const moment = require('moment')
const { fetchAll, updateAll, lsDir } = require('./helpers')

const oldNameFormat = /\d{4}\d{2}_mgen\.pdf/
const isOldFile = file => {
  return oldNameFormat.exec(file.attributes.name)
}

const byDate = entry => new Date(entry.date)

const composeFilters = filters => x => {
  for (let f of filters) {
    const res = f(x)
    if (!res) {
      return false
    }
  }
  return true
}

const getFileDateFromOldFile = file => {
  const strDate = oldNameFormat.exec(file.attributes.name)[0]
  const date = moment(strDate, 'YYYYMM')
    .startOf('month')
    .toDate()
  return date
}

const removeReferencesFromBills = async oldFileIds => {
  const indexedIds = keyBy(oldFileIds)
  log('info', `Removing references ${oldFileIds}`)
  const bills = await fetchAll('io.cozy.bills')
  const update = bill => {
    if (bill.invoice && indexedIds[bill.invoice.split(':')[1]]) {
      bill.invoice = null
      return bill
    }
  }
  const updated = bills.map(update).filter(Boolean)
  log('info', `Remove references in ${updated.length} doc(s)`)
  await updateAll('io.cozy.bills', updated)
}

const removeOldFiles = async (fields, entries) => {
  log('info', `Removing old MGEN files`)
  const folder = await cozyClient.files.statByPath(fields.folderPath)
  const files = await lsDir(folder)
  log('info', `Found ${files.length} files`)
  const entriesByDate = sortBy(entries, byDate)
  const oldestEntry = first(entriesByDate)

  const filters = [isOldFile]
  if (oldestEntry) {
    const oldestDate = new Date(oldestEntry.date)
    log('info', `Oldest date ${oldestDate}`)
    const youngerThanOldestEntry = file =>
      getFileDateFromOldFile(file) > +oldestDate
    filters.push(youngerThanOldestEntry)
  }
  const oldMgenFiles = files.filter(composeFilters(filters))
  log('info', `Found ${oldMgenFiles.length} old MGEN files`)
  const fileIds = oldMgenFiles.map(file => file.id)
  return Promise.all(
    bluebird.map(
      oldMgenFiles,
      file => {
        log('info', `Deleting file ${file.attributes.name}`)
        return cozyClient.files.destroyById(file.id)
      },
      { concurrency: 5 }
    ),
    removeReferencesFromBills(fileIds)
  )
}

module.exports = removeOldFiles
