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
  const entries = [
    { date: '2011-11-10T00:00Z', amount: 10 },
    { date: '2011-11-08T00:00Z', amount: 10 },
    { date: '2011-12-10T00:00Z', amount: 10 },
    { date: '2011-11-05T00:00Z', amount: 10 }
  ]
  beforeEach(() => {
    client.files.statByPath.mockReturnValue(asyncResolve({ _id: 'folderId' }))
    client.fetchJSON.mockReturnValue(
      asyncResolve({
        included: [
          { id: 1, attributes: { name: 'Hello.pdf' } },
          { id: 2, attributes: { name: '201111_mgen.pdf' } },
          { id: 3, attributes: { name: '201112_mgen.pdf' } },
          { id: 4, attributes: { name: '201201_mgen.pdf' } },
          { id: 5, attributes: { name: '201202_mgen.pdf' } },
          { id: 6, attributes: { name: '201203_mgen.pdf' } },
          { id: 7, attributes: { name: '2012-12-17-mgen.pdf' } },
          { id: 8, attributes: { name: '201109_mgen.pdf' } },
          { id: 9, attributes: { name: '201110_mgen.pdf' } }
        ]
      })
    )
    client.files.destroyById.mockReset()
  })
  it('should be able to recognize old files', async () => {
    await removeOldFiles({ folderPath: '/' })
    expect(client.files.destroyById).toHaveBeenCalledTimes(7)
    expect(client.files.destroyById).toHaveBeenCalledWith(2)
    expect(client.files.destroyById).toHaveBeenCalledWith(3)
    expect(client.files.destroyById).toHaveBeenCalledWith(4)
    expect(client.files.destroyById).toHaveBeenCalledWith(5)
    expect(client.files.destroyById).toHaveBeenCalledWith(6)
  })

  it('should not destroy files that are older than the oldest entry', async () => {
    await removeOldFiles({ folderPath: '/' }, entries)
    expect(client.files.destroyById).toHaveBeenCalledTimes(4)
    expect(client.files.destroyById).not.toHaveBeenCalledWith(9)
    expect(client.files.destroyById).not.toHaveBeenCalledWith(8)
    expect(client.files.destroyById).not.toHaveBeenCalledWith(2)
  })
})
