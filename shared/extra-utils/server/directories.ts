/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import { pathExists, readdir } from 'fs-extra'
import { join } from 'path'
import { root } from '@server/helpers/core-utils'
import { ServerInfo } from './servers'

async function checkTmpIsEmpty (server: ServerInfo) {
  await checkDirectoryIsEmpty(server, 'tmp', [ 'plugins-global.css', 'hls', 'resumable-uploads' ])

  if (await pathExists(join('test' + server.internalServerNumber, 'tmp', 'hls'))) {
    await checkDirectoryIsEmpty(server, 'tmp/hls')
  }
}

async function checkDirectoryIsEmpty (server: ServerInfo, directory: string, exceptions: string[] = []) {
  const testDirectory = 'test' + server.internalServerNumber

  const directoryPath = join(root(), testDirectory, directory)

  const directoryExists = await pathExists(directoryPath)
  expect(directoryExists).to.be.true

  const files = await readdir(directoryPath)
  const filtered = files.filter(f => exceptions.includes(f) === false)

  expect(filtered).to.have.lengthOf(0)
}

export {
  checkTmpIsEmpty,
  checkDirectoryIsEmpty
}
