jest.mock('cozy-konnector-libs/helpers/cozy-client-js-stub', () => ({
  fetchJSON: jest.fn(),
  files: {
    statByPath: jest.fn(),
    destroyById: jest.fn()
  }
}))

const removeOldFiles = require('./removeOldFiles')
const client = require('cozy-konnector-libs/helpers/cozy-client-js-stub')
const asyncResolve = data => {
  return new Promise(resolve => {
    setImmediate(() => resolve(data))
  })
}

describe('remove old files', () => {
  beforeEach(() => {
    client.files.statByPath.mockReturnValue(asyncResolve({ _id: 'folderId' }))
    client.fetchJSON.mockReturnValue(asyncResolve({
      included: [
        { id: 1, attributes: { name: 'Hello.pdf' }},
        { id: 2, attributes: { name: '201215_mgen.pdf' }},
        { id: 3, attributes: { name: '201217_mgen.pdf' }},
        { id: 4, attributes: { name: '2012-12-17-mgen.pdf' }},
      ]
    }))
  })
  it('should be able to recognize old files', async () => {
    await removeOldFiles({ folderPath: '/' })
    expect(client.files.destroyById).toHaveBeenCalledTimes(2)
    expect(client.files.destroyById).toHaveBeenCalledWith(2)
    expect(client.files.destroyById).toHaveBeenCalledWith(3)
  })
})
