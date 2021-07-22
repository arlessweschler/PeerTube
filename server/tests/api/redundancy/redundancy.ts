/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import 'mocha'
import * as chai from 'chai'
import { readdir } from 'fs-extra'
import * as magnetUtil from 'magnet-uri'
import { join } from 'path'
import {
  checkSegmentHash,
  checkVideoFilesWereRemoved,
  cleanupTests,
  createMultipleServers,
  doubleFollow,
  killallServers,
  makeGetRequest,
  PeerTubeServer,
  root,
  setAccessTokensToServers,
  wait,
  waitJobs
} from '@shared/extra-utils'
import { HttpStatusCode, VideoPrivacy, VideoRedundancyStrategy, VideoRedundancyStrategyWithManual } from '@shared/models'

const expect = chai.expect

let servers: PeerTubeServer[] = []
let video1Server2UUID: string
let video1Server2Id: number

function checkMagnetWebseeds (file: { magnetUri: string, resolution: { id: number } }, baseWebseeds: string[], server: PeerTubeServer) {
  const parsed = magnetUtil.decode(file.magnetUri)

  for (const ws of baseWebseeds) {
    const found = parsed.urlList.find(url => url === `${ws}-${file.resolution.id}.mp4`)
    expect(found, `Webseed ${ws} not found in ${file.magnetUri} on server ${server.url}`).to.not.be.undefined
  }

  expect(parsed.urlList).to.have.lengthOf(baseWebseeds.length)
}

async function createSingleServers (strategy: VideoRedundancyStrategy | null, additionalParams: any = {}, withWebtorrent = true) {
  const strategies: any[] = []

  if (strategy !== null) {
    strategies.push(
      {
        min_lifetime: '1 hour',
        strategy: strategy,
        size: '400KB',

        ...additionalParams
      }
    )
  }

  const config = {
    transcoding: {
      webtorrent: {
        enabled: withWebtorrent
      },
      hls: {
        enabled: true
      }
    },
    redundancy: {
      videos: {
        check_interval: '5 seconds',
        strategies
      }
    }
  }

  servers = await createMultipleServers(3, config)

  // Get the access tokens
  await setAccessTokensToServers(servers)

  {
    const { uuid, id } = await servers[1].videos.upload({ attributes: { name: 'video 1 server 2' } })
    video1Server2UUID = uuid
    video1Server2Id = id

    await servers[1].videos.view({ id: video1Server2UUID })
  }

  await waitJobs(servers)

  // Server 1 and server 2 follow each other
  await doubleFollow(servers[0], servers[1])
  // Server 1 and server 3 follow each other
  await doubleFollow(servers[0], servers[2])
  // Server 2 and server 3 follow each other
  await doubleFollow(servers[1], servers[2])

  await waitJobs(servers)
}

async function check1WebSeed (videoUUID?: string) {
  if (!videoUUID) videoUUID = video1Server2UUID

  const webseeds = [
    `http://localhost:${servers[1].port}/static/webseed/${videoUUID}`
  ]

  for (const server of servers) {
    // With token to avoid issues with video follow constraints
    const video = await server.videos.getWithToken({ id: videoUUID })

    for (const f of video.files) {
      checkMagnetWebseeds(f, webseeds, server)
    }
  }
}

async function check2Webseeds (videoUUID?: string) {
  if (!videoUUID) videoUUID = video1Server2UUID

  const webseeds = [
    `http://localhost:${servers[0].port}/static/redundancy/${videoUUID}`,
    `http://localhost:${servers[1].port}/static/webseed/${videoUUID}`
  ]

  for (const server of servers) {
    const video = await server.videos.get({ id: videoUUID })

    for (const file of video.files) {
      checkMagnetWebseeds(file, webseeds, server)

      await makeGetRequest({
        url: servers[0].url,
        expectedStatus: HttpStatusCode.OK_200,
        path: '/static/redundancy/' + `${videoUUID}-${file.resolution.id}.mp4`,
        contentType: null
      })
      await makeGetRequest({
        url: servers[1].url,
        expectedStatus: HttpStatusCode.OK_200,
        path: `/static/webseed/${videoUUID}-${file.resolution.id}.mp4`,
        contentType: null
      })
    }
  }

  const directories = [
    'test' + servers[0].internalServerNumber + '/redundancy',
    'test' + servers[1].internalServerNumber + '/videos'
  ]

  for (const directory of directories) {
    const files = await readdir(join(root(), directory))
    expect(files).to.have.length.at.least(4)

    for (const resolution of [ 240, 360, 480, 720 ]) {
      expect(files.find(f => f === `${videoUUID}-${resolution}.mp4`)).to.not.be.undefined
    }
  }
}

async function check0PlaylistRedundancies (videoUUID?: string) {
  if (!videoUUID) videoUUID = video1Server2UUID

  for (const server of servers) {
    // With token to avoid issues with video follow constraints
    const video = await server.videos.getWithToken({ id: videoUUID })

    expect(video.streamingPlaylists).to.be.an('array')
    expect(video.streamingPlaylists).to.have.lengthOf(1)
    expect(video.streamingPlaylists[0].redundancies).to.have.lengthOf(0)
  }
}

async function check1PlaylistRedundancies (videoUUID?: string) {
  if (!videoUUID) videoUUID = video1Server2UUID

  for (const server of servers) {
    const video = await server.videos.get({ id: videoUUID })

    expect(video.streamingPlaylists).to.have.lengthOf(1)
    expect(video.streamingPlaylists[0].redundancies).to.have.lengthOf(1)

    const redundancy = video.streamingPlaylists[0].redundancies[0]

    expect(redundancy.baseUrl).to.equal(servers[0].url + '/static/redundancy/hls/' + videoUUID)
  }

  const baseUrlPlaylist = servers[1].url + '/static/streaming-playlists/hls'
  const baseUrlSegment = servers[0].url + '/static/redundancy/hls'

  const video = await servers[0].videos.get({ id: videoUUID })
  const hlsPlaylist = video.streamingPlaylists[0]

  for (const resolution of [ 240, 360, 480, 720 ]) {
    await checkSegmentHash({ server: servers[1], baseUrlPlaylist, baseUrlSegment, videoUUID, resolution, hlsPlaylist })
  }

  const directories = [
    'test' + servers[0].internalServerNumber + '/redundancy/hls',
    'test' + servers[1].internalServerNumber + '/streaming-playlists/hls'
  ]

  for (const directory of directories) {
    const files = await readdir(join(root(), directory, videoUUID))
    expect(files).to.have.length.at.least(4)

    for (const resolution of [ 240, 360, 480, 720 ]) {
      const filename = `${videoUUID}-${resolution}-fragmented.mp4`

      expect(files.find(f => f === filename)).to.not.be.undefined
    }
  }
}

async function checkStatsGlobal (strategy: VideoRedundancyStrategyWithManual) {
  let totalSize: number = null
  let statsLength = 1

  if (strategy !== 'manual') {
    totalSize = 409600
    statsLength = 2
  }

  const data = await servers[0].stats.get()
  expect(data.videosRedundancy).to.have.lengthOf(statsLength)

  const stat = data.videosRedundancy[0]
  expect(stat.strategy).to.equal(strategy)
  expect(stat.totalSize).to.equal(totalSize)

  return stat
}

async function checkStatsWith1Redundancy (strategy: VideoRedundancyStrategyWithManual, onlyHls = false) {
  const stat = await checkStatsGlobal(strategy)

  expect(stat.totalUsed).to.be.at.least(1).and.below(409601)
  expect(stat.totalVideoFiles).to.equal(onlyHls ? 4 : 8)
  expect(stat.totalVideos).to.equal(1)
}

async function checkStatsWithoutRedundancy (strategy: VideoRedundancyStrategyWithManual) {
  const stat = await checkStatsGlobal(strategy)

  expect(stat.totalUsed).to.equal(0)
  expect(stat.totalVideoFiles).to.equal(0)
  expect(stat.totalVideos).to.equal(0)
}

async function findServerFollows () {
  const body = await servers[0].follows.getFollowings({ start: 0, count: 5, sort: '-createdAt' })
  const follows = body.data
  const server2 = follows.find(f => f.following.host === `localhost:${servers[1].port}`)
  const server3 = follows.find(f => f.following.host === `localhost:${servers[2].port}`)

  return { server2, server3 }
}

async function enableRedundancyOnServer1 () {
  await servers[0].redundancy.updateRedundancy({ host: servers[1].host, redundancyAllowed: true })

  const { server2, server3 } = await findServerFollows()

  expect(server3).to.not.be.undefined
  expect(server3.following.hostRedundancyAllowed).to.be.false

  expect(server2).to.not.be.undefined
  expect(server2.following.hostRedundancyAllowed).to.be.true
}

async function disableRedundancyOnServer1 () {
  await servers[0].redundancy.updateRedundancy({ host: servers[1].host, redundancyAllowed: false })

  const { server2, server3 } = await findServerFollows()

  expect(server3).to.not.be.undefined
  expect(server3.following.hostRedundancyAllowed).to.be.false

  expect(server2).to.not.be.undefined
  expect(server2.following.hostRedundancyAllowed).to.be.false
}

describe('Test videos redundancy', function () {

  describe('With most-views strategy', function () {
    const strategy = 'most-views'

    before(function () {
      this.timeout(120000)

      return createSingleServers(strategy)
    })

    it('Should have 1 webseed on the first video', async function () {
      await check1WebSeed()
      await check0PlaylistRedundancies()
      await checkStatsWithoutRedundancy(strategy)
    })

    it('Should enable redundancy on server 1', function () {
      return enableRedundancyOnServer1()
    })

    it('Should have 2 webseeds on the first video', async function () {
      this.timeout(80000)

      await waitJobs(servers)
      await servers[0].servers.waitUntilLog('Duplicated ', 5)
      await waitJobs(servers)

      await check2Webseeds()
      await check1PlaylistRedundancies()
      await checkStatsWith1Redundancy(strategy)
    })

    it('Should undo redundancy on server 1 and remove duplicated videos', async function () {
      this.timeout(80000)

      await disableRedundancyOnServer1()

      await waitJobs(servers)
      await wait(5000)

      await check1WebSeed()
      await check0PlaylistRedundancies()

      await checkVideoFilesWereRemoved(video1Server2UUID, servers[0], [ 'videos', join('playlists', 'hls') ])
    })

    after(async function () {
      return cleanupTests(servers)
    })
  })

  describe('With trending strategy', function () {
    const strategy = 'trending'

    before(function () {
      this.timeout(120000)

      return createSingleServers(strategy)
    })

    it('Should have 1 webseed on the first video', async function () {
      await check1WebSeed()
      await check0PlaylistRedundancies()
      await checkStatsWithoutRedundancy(strategy)
    })

    it('Should enable redundancy on server 1', function () {
      return enableRedundancyOnServer1()
    })

    it('Should have 2 webseeds on the first video', async function () {
      this.timeout(80000)

      await waitJobs(servers)
      await servers[0].servers.waitUntilLog('Duplicated ', 5)
      await waitJobs(servers)

      await check2Webseeds()
      await check1PlaylistRedundancies()
      await checkStatsWith1Redundancy(strategy)
    })

    it('Should unfollow on server 1 and remove duplicated videos', async function () {
      this.timeout(80000)

      await servers[0].follows.unfollow({ target: servers[1] })

      await waitJobs(servers)
      await wait(5000)

      await check1WebSeed()
      await check0PlaylistRedundancies()

      await checkVideoFilesWereRemoved(video1Server2UUID, servers[0], [ 'videos' ])
    })

    after(async function () {
      await cleanupTests(servers)
    })
  })

  describe('With recently added strategy', function () {
    const strategy = 'recently-added'

    before(function () {
      this.timeout(120000)

      return createSingleServers(strategy, { min_views: 3 })
    })

    it('Should have 1 webseed on the first video', async function () {
      await check1WebSeed()
      await check0PlaylistRedundancies()
      await checkStatsWithoutRedundancy(strategy)
    })

    it('Should enable redundancy on server 1', function () {
      return enableRedundancyOnServer1()
    })

    it('Should still have 1 webseed on the first video', async function () {
      this.timeout(80000)

      await waitJobs(servers)
      await wait(15000)
      await waitJobs(servers)

      await check1WebSeed()
      await check0PlaylistRedundancies()
      await checkStatsWithoutRedundancy(strategy)
    })

    it('Should view 2 times the first video to have > min_views config', async function () {
      this.timeout(80000)

      await servers[0].videos.view({ id: video1Server2UUID })
      await servers[2].videos.view({ id: video1Server2UUID })

      await wait(10000)
      await waitJobs(servers)
    })

    it('Should have 2 webseeds on the first video', async function () {
      this.timeout(80000)

      await waitJobs(servers)
      await servers[0].servers.waitUntilLog('Duplicated ', 5)
      await waitJobs(servers)

      await check2Webseeds()
      await check1PlaylistRedundancies()
      await checkStatsWith1Redundancy(strategy)
    })

    it('Should remove the video and the redundancy files', async function () {
      this.timeout(20000)

      await servers[1].videos.remove({ id: video1Server2UUID })

      await waitJobs(servers)

      for (const server of servers) {
        await checkVideoFilesWereRemoved(video1Server2UUID, server)
      }
    })

    after(async function () {
      await cleanupTests(servers)
    })
  })

  describe('With only HLS files', function () {
    const strategy = 'recently-added'

    before(async function () {
      this.timeout(120000)

      await createSingleServers(strategy, { min_views: 3 }, false)
    })

    it('Should have 0 playlist redundancy on the first video', async function () {
      await check1WebSeed()
      await check0PlaylistRedundancies()
    })

    it('Should enable redundancy on server 1', function () {
      return enableRedundancyOnServer1()
    })

    it('Should still have 0 redundancy on the first video', async function () {
      this.timeout(80000)

      await waitJobs(servers)
      await wait(15000)
      await waitJobs(servers)

      await check0PlaylistRedundancies()
      await checkStatsWithoutRedundancy(strategy)
    })

    it('Should have 1 redundancy on the first video', async function () {
      this.timeout(160000)

      await servers[0].videos.view({ id: video1Server2UUID })
      await servers[2].videos.view({ id: video1Server2UUID })

      await wait(10000)
      await waitJobs(servers)

      await waitJobs(servers)
      await servers[0].servers.waitUntilLog('Duplicated ', 1)
      await waitJobs(servers)

      await check1PlaylistRedundancies()
      await checkStatsWith1Redundancy(strategy, true)
    })

    it('Should remove the video and the redundancy files', async function () {
      this.timeout(20000)

      await servers[1].videos.remove({ id: video1Server2UUID })

      await waitJobs(servers)

      for (const server of servers) {
        await checkVideoFilesWereRemoved(video1Server2UUID, server)
      }
    })

    after(async function () {
      await cleanupTests(servers)
    })
  })

  describe('With manual strategy', function () {
    before(function () {
      this.timeout(120000)

      return createSingleServers(null)
    })

    it('Should have 1 webseed on the first video', async function () {
      await check1WebSeed()
      await check0PlaylistRedundancies()
      await checkStatsWithoutRedundancy('manual')
    })

    it('Should create a redundancy on first video', async function () {
      await servers[0].redundancy.addVideo({ videoId: video1Server2Id })
    })

    it('Should have 2 webseeds on the first video', async function () {
      this.timeout(80000)

      await waitJobs(servers)
      await servers[0].servers.waitUntilLog('Duplicated ', 5)
      await waitJobs(servers)

      await check2Webseeds()
      await check1PlaylistRedundancies()
      await checkStatsWith1Redundancy('manual')
    })

    it('Should manually remove redundancies on server 1 and remove duplicated videos', async function () {
      this.timeout(80000)

      const body = await servers[0].redundancy.listVideos({ target: 'remote-videos' })

      const videos = body.data
      expect(videos).to.have.lengthOf(1)

      const video = videos[0]

      for (const r of video.redundancies.files.concat(video.redundancies.streamingPlaylists)) {
        await servers[0].redundancy.removeVideo({ redundancyId: r.id })
      }

      await waitJobs(servers)
      await wait(5000)

      await check1WebSeed()
      await check0PlaylistRedundancies()

      await checkVideoFilesWereRemoved(video1Server2UUID, servers[0], [ 'videos' ])
    })

    after(async function () {
      await cleanupTests(servers)
    })
  })

  describe('Test expiration', function () {
    const strategy = 'recently-added'

    async function checkContains (servers: PeerTubeServer[], str: string) {
      for (const server of servers) {
        const video = await server.videos.get({ id: video1Server2UUID })

        for (const f of video.files) {
          expect(f.magnetUri).to.contain(str)
        }
      }
    }

    async function checkNotContains (servers: PeerTubeServer[], str: string) {
      for (const server of servers) {
        const video = await server.videos.get({ id: video1Server2UUID })

        for (const f of video.files) {
          expect(f.magnetUri).to.not.contain(str)
        }
      }
    }

    before(async function () {
      this.timeout(120000)

      await createSingleServers(strategy, { min_lifetime: '7 seconds', min_views: 0 })

      await enableRedundancyOnServer1()
    })

    it('Should still have 2 webseeds after 10 seconds', async function () {
      this.timeout(80000)

      await wait(10000)

      try {
        await checkContains(servers, 'http%3A%2F%2Flocalhost%3A' + servers[0].port)
      } catch {
        // Maybe a server deleted a redundancy in the scheduler
        await wait(2000)

        await checkContains(servers, 'http%3A%2F%2Flocalhost%3A' + servers[0].port)
      }
    })

    it('Should stop server 1 and expire video redundancy', async function () {
      this.timeout(80000)

      await killallServers([ servers[0] ])

      await wait(15000)

      await checkNotContains([ servers[1], servers[2] ], 'http%3A%2F%2Flocalhost%3A' + servers[0].port)
    })

    after(async function () {
      await cleanupTests(servers)
    })
  })

  describe('Test file replacement', function () {
    let video2Server2UUID: string
    const strategy = 'recently-added'

    before(async function () {
      this.timeout(120000)

      await createSingleServers(strategy, { min_lifetime: '7 seconds', min_views: 0 })

      await enableRedundancyOnServer1()

      await waitJobs(servers)
      await servers[0].servers.waitUntilLog('Duplicated ', 5)
      await waitJobs(servers)

      await check2Webseeds(video1Server2UUID)
      await check1PlaylistRedundancies(video1Server2UUID)
      await checkStatsWith1Redundancy(strategy)

      const { uuid } = await servers[1].videos.upload({ attributes: { name: 'video 2 server 2', privacy: VideoPrivacy.PRIVATE } })
      video2Server2UUID = uuid

      // Wait transcoding before federation
      await waitJobs(servers)

      await servers[1].videos.update({ id: video2Server2UUID, attributes: { privacy: VideoPrivacy.PUBLIC } })
    })

    it('Should cache video 2 webseeds on the first video', async function () {
      this.timeout(120000)

      await waitJobs(servers)

      let checked = false

      while (checked === false) {
        await wait(1000)

        try {
          await check1WebSeed(video1Server2UUID)
          await check0PlaylistRedundancies(video1Server2UUID)

          await check2Webseeds(video2Server2UUID)
          await check1PlaylistRedundancies(video2Server2UUID)

          checked = true
        } catch {
          checked = false
        }
      }
    })

    it('Should disable strategy and remove redundancies', async function () {
      this.timeout(80000)

      await waitJobs(servers)

      await killallServers([ servers[0] ])
      await servers[0].run({
        redundancy: {
          videos: {
            check_interval: '1 second',
            strategies: []
          }
        }
      })

      await waitJobs(servers)

      await checkVideoFilesWereRemoved(video1Server2UUID, servers[0], [ join('redundancy', 'hls') ])
    })

    after(async function () {
      await cleanupTests(servers)
    })
  })
})
