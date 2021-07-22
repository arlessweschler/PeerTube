/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import 'mocha'
import * as chai from 'chai'
import { cleanupTests, createMultipleServers, doubleFollow, PeerTubeServer, setAccessTokensToServers, waitJobs } from '@shared/extra-utils'
import { VideoFile } from '@shared/models'

const expect = chai.expect

function assertVideoProperties (video: VideoFile, resolution: number, extname: string, size?: number) {
  expect(video).to.have.nested.property('resolution.id', resolution)
  expect(video).to.have.property('torrentUrl').that.includes(`-${resolution}.torrent`)
  expect(video).to.have.property('fileUrl').that.includes(`.${extname}`)
  expect(video).to.have.property('magnetUri').that.includes(`.${extname}`)
  expect(video).to.have.property('size').that.is.above(0)

  if (size) expect(video.size).to.equal(size)
}

describe('Test create import video jobs', function () {
  this.timeout(60000)

  let servers: PeerTubeServer[] = []
  let video1UUID: string
  let video2UUID: string

  before(async function () {
    this.timeout(90000)

    // Run server 2 to have transcoding enabled
    servers = await createMultipleServers(2)
    await setAccessTokensToServers(servers)

    await doubleFollow(servers[0], servers[1])

    // Upload two videos for our needs
    {
      const { uuid } = await servers[0].videos.upload({ attributes: { name: 'video1' } })
      video1UUID = uuid
    }

    {
      const { uuid } = await servers[1].videos.upload({ attributes: { name: 'video2' } })
      video2UUID = uuid
    }

    // Transcoding
    await waitJobs(servers)
  })

  it('Should run a import job on video 1 with a lower resolution', async function () {
    const command = `npm run create-import-video-file-job -- -v ${video1UUID} -i server/tests/fixtures/video_short-480.webm`
    await servers[0].cli.execWithEnv(command)

    await waitJobs(servers)

    for (const server of servers) {
      const { data: videos } = await server.videos.list()
      expect(videos).to.have.lengthOf(2)

      const video = videos.find(({ uuid }) => uuid === video1UUID)
      const videoDetails = await server.videos.get({ id: video.uuid })

      expect(videoDetails.files).to.have.lengthOf(2)
      const [ originalVideo, transcodedVideo ] = videoDetails.files
      assertVideoProperties(originalVideo, 720, 'webm', 218910)
      assertVideoProperties(transcodedVideo, 480, 'webm', 69217)
    }
  })

  it('Should run a import job on video 2 with the same resolution and a different extension', async function () {
    const command = `npm run create-import-video-file-job -- -v ${video2UUID} -i server/tests/fixtures/video_short.ogv`
    await servers[1].cli.execWithEnv(command)

    await waitJobs(servers)

    for (const server of servers) {
      const { data: videos } = await server.videos.list()
      expect(videos).to.have.lengthOf(2)

      const video = videos.find(({ uuid }) => uuid === video2UUID)
      const videoDetails = await server.videos.get({ id: video.uuid })

      expect(videoDetails.files).to.have.lengthOf(4)
      const [ originalVideo, transcodedVideo420, transcodedVideo320, transcodedVideo240 ] = videoDetails.files
      assertVideoProperties(originalVideo, 720, 'ogv', 140849)
      assertVideoProperties(transcodedVideo420, 480, 'mp4')
      assertVideoProperties(transcodedVideo320, 360, 'mp4')
      assertVideoProperties(transcodedVideo240, 240, 'mp4')
    }
  })

  it('Should run a import job on video 2 with the same resolution and the same extension', async function () {
    const command = `npm run create-import-video-file-job -- -v ${video1UUID} -i server/tests/fixtures/video_short2.webm`
    await servers[0].cli.execWithEnv(command)

    await waitJobs(servers)

    for (const server of servers) {
      const { data: videos } = await server.videos.list()
      expect(videos).to.have.lengthOf(2)

      const video = videos.find(({ uuid }) => uuid === video1UUID)
      const videoDetails = await server.videos.get({ id: video.uuid })

      expect(videoDetails.files).to.have.lengthOf(2)
      const [ video720, video480 ] = videoDetails.files
      assertVideoProperties(video720, 720, 'webm', 942961)
      assertVideoProperties(video480, 480, 'webm', 69217)
    }
  })

  after(async function () {
    await cleanupTests(servers)
  })
})
