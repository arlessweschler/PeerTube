/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import 'mocha'
import * as chai from 'chai'
import {
  areHttpImportTestsDisabled,
  cleanupTests,
  doubleFollow,
  flushAndRunMultipleServers,
  getMyUserInformation,
  getMyVideos,
  getVideo,
  getVideosList,
  ImportsCommand,
  ServerInfo,
  setAccessTokensToServers,
  testCaptionFile,
  testImage,
  waitJobs
} from '@shared/extra-utils'
import { VideoDetails, VideoPrivacy, VideoResolution } from '@shared/models'

const expect = chai.expect

describe('Test video imports', function () {
  let servers: ServerInfo[] = []
  let channelIdServer1: number
  let channelIdServer2: number

  if (areHttpImportTestsDisabled()) return

  async function checkVideosServer1 (server: ServerInfo, idHttp: string, idMagnet: string, idTorrent: string) {
    const resHttp = await getVideo(server.url, idHttp)
    const videoHttp: VideoDetails = resHttp.body

    expect(videoHttp.name).to.equal('small video - youtube')
    // FIXME: youtube-dl seems broken
    // expect(videoHttp.category.label).to.equal('News & Politics')
    // expect(videoHttp.licence.label).to.equal('Attribution')
    expect(videoHttp.language.label).to.equal('Unknown')
    expect(videoHttp.nsfw).to.be.false
    expect(videoHttp.description).to.equal('this is a super description')
    expect(videoHttp.tags).to.deep.equal([ 'tag1', 'tag2' ])
    expect(videoHttp.files).to.have.lengthOf(1)

    const originallyPublishedAt = new Date(videoHttp.originallyPublishedAt)
    expect(originallyPublishedAt.getDate()).to.equal(14)
    expect(originallyPublishedAt.getMonth()).to.equal(0)
    expect(originallyPublishedAt.getFullYear()).to.equal(2019)

    const resMagnet = await getVideo(server.url, idMagnet)
    const videoMagnet: VideoDetails = resMagnet.body
    const resTorrent = await getVideo(server.url, idTorrent)
    const videoTorrent: VideoDetails = resTorrent.body

    for (const video of [ videoMagnet, videoTorrent ]) {
      expect(video.category.label).to.equal('Misc')
      expect(video.licence.label).to.equal('Unknown')
      expect(video.language.label).to.equal('Unknown')
      expect(video.nsfw).to.be.false
      expect(video.description).to.equal('this is a super torrent description')
      expect(video.tags).to.deep.equal([ 'tag_torrent1', 'tag_torrent2' ])
      expect(video.files).to.have.lengthOf(1)
    }

    expect(videoTorrent.name).to.contain('你好 世界 720p.mp4')
    expect(videoMagnet.name).to.contain('super peertube2 video')

    const bodyCaptions = await server.captionsCommand.listVideoCaptions({ videoId: idHttp })
    expect(bodyCaptions.total).to.equal(2)
  }

  async function checkVideoServer2 (server: ServerInfo, id: number | string) {
    const res = await getVideo(server.url, id)
    const video: VideoDetails = res.body

    expect(video.name).to.equal('my super name')
    expect(video.category.label).to.equal('Entertainment')
    expect(video.licence.label).to.equal('Public Domain Dedication')
    expect(video.language.label).to.equal('English')
    expect(video.nsfw).to.be.false
    expect(video.description).to.equal('my super description')
    expect(video.tags).to.deep.equal([ 'supertag1', 'supertag2' ])

    expect(video.files).to.have.lengthOf(1)

    const bodyCaptions = await server.captionsCommand.listVideoCaptions({ videoId: id })
    expect(bodyCaptions.total).to.equal(2)
  }

  before(async function () {
    this.timeout(30_000)

    // Run servers
    servers = await flushAndRunMultipleServers(2)

    await setAccessTokensToServers(servers)

    {
      const res = await getMyUserInformation(servers[0].url, servers[0].accessToken)
      channelIdServer1 = res.body.videoChannels[0].id
    }

    {
      const res = await getMyUserInformation(servers[1].url, servers[1].accessToken)
      channelIdServer2 = res.body.videoChannels[0].id
    }

    await doubleFollow(servers[0], servers[1])
  })

  it('Should import videos on server 1', async function () {
    this.timeout(60_000)

    const baseAttributes = {
      channelId: channelIdServer1,
      privacy: VideoPrivacy.PUBLIC
    }

    {
      const attributes = { ...baseAttributes, targetUrl: ImportsCommand.getYoutubeVideoUrl() }
      const { video } = await servers[0].importsCommand.importVideo({ attributes })
      expect(video.name).to.equal('small video - youtube')

      expect(video.thumbnailPath).to.match(new RegExp(`^/static/thumbnails/.+.jpg$`))
      expect(video.previewPath).to.match(new RegExp(`^/lazy-static/previews/.+.jpg$`))

      await testImage(servers[0].url, 'video_import_thumbnail', video.thumbnailPath)
      await testImage(servers[0].url, 'video_import_preview', video.previewPath)

      const bodyCaptions = await servers[0].captionsCommand.listVideoCaptions({ videoId: video.id })
      const videoCaptions = bodyCaptions.data
      expect(videoCaptions).to.have.lengthOf(2)

      const enCaption = videoCaptions.find(caption => caption.language.id === 'en')
      expect(enCaption).to.exist
      expect(enCaption.language.label).to.equal('English')
      expect(enCaption.captionPath).to.match(new RegExp(`^/lazy-static/video-captions/.+-en.vtt$`))
      await testCaptionFile(servers[0].url, enCaption.captionPath, `WEBVTT
Kind: captions
Language: en

00:00:01.600 --> 00:00:04.200
English (US)

00:00:05.900 --> 00:00:07.999
This is a subtitle in American English

00:00:10.000 --> 00:00:14.000
Adding subtitles is very easy to do`)

      const frCaption = videoCaptions.find(caption => caption.language.id === 'fr')
      expect(frCaption).to.exist
      expect(frCaption.language.label).to.equal('French')
      expect(frCaption.captionPath).to.match(new RegExp(`^/lazy-static/video-captions/.+-fr.vtt`))
      await testCaptionFile(servers[0].url, frCaption.captionPath, `WEBVTT
Kind: captions
Language: fr

00:00:01.600 --> 00:00:04.200
Français (FR)

00:00:05.900 --> 00:00:07.999
C'est un sous-titre français

00:00:10.000 --> 00:00:14.000
Ajouter un sous-titre est vraiment facile`)
    }

    {
      const attributes = {
        ...baseAttributes,
        magnetUri: ImportsCommand.getMagnetURI(),
        description: 'this is a super torrent description',
        tags: [ 'tag_torrent1', 'tag_torrent2' ]
      }
      const { video } = await servers[0].importsCommand.importVideo({ attributes })
      expect(video.name).to.equal('super peertube2 video')
    }

    {
      const attributes = {
        ...baseAttributes,
        torrentfile: 'video-720p.torrent' as any,
        description: 'this is a super torrent description',
        tags: [ 'tag_torrent1', 'tag_torrent2' ]
      }
      const { video } = await servers[0].importsCommand.importVideo({ attributes })
      expect(video.name).to.equal('你好 世界 720p.mp4')
    }
  })

  it('Should list the videos to import in my videos on server 1', async function () {
    const res = await getMyVideos(servers[0].url, servers[0].accessToken, 0, 5, 'createdAt')

    expect(res.body.total).to.equal(3)

    const videos = res.body.data
    expect(videos).to.have.lengthOf(3)
    expect(videos[0].name).to.equal('small video - youtube')
    expect(videos[1].name).to.equal('super peertube2 video')
    expect(videos[2].name).to.equal('你好 世界 720p.mp4')
  })

  it('Should list the videos to import in my imports on server 1', async function () {
    const { total, data: videoImports } = await servers[0].importsCommand.getMyVideoImports({ sort: '-createdAt' })
    expect(total).to.equal(3)

    expect(videoImports).to.have.lengthOf(3)

    expect(videoImports[2].targetUrl).to.equal(ImportsCommand.getYoutubeVideoUrl())
    expect(videoImports[2].magnetUri).to.be.null
    expect(videoImports[2].torrentName).to.be.null
    expect(videoImports[2].video.name).to.equal('small video - youtube')

    expect(videoImports[1].targetUrl).to.be.null
    expect(videoImports[1].magnetUri).to.equal(ImportsCommand.getMagnetURI())
    expect(videoImports[1].torrentName).to.be.null
    expect(videoImports[1].video.name).to.equal('super peertube2 video')

    expect(videoImports[0].targetUrl).to.be.null
    expect(videoImports[0].magnetUri).to.be.null
    expect(videoImports[0].torrentName).to.equal('video-720p.torrent')
    expect(videoImports[0].video.name).to.equal('你好 世界 720p.mp4')
  })

  it('Should have the video listed on the two instances', async function () {
    this.timeout(120_000)

    await waitJobs(servers)

    for (const server of servers) {
      const res = await getVideosList(server.url)
      expect(res.body.total).to.equal(3)
      expect(res.body.data).to.have.lengthOf(3)

      const [ videoHttp, videoMagnet, videoTorrent ] = res.body.data
      await checkVideosServer1(server, videoHttp.uuid, videoMagnet.uuid, videoTorrent.uuid)
    }
  })

  it('Should import a video on server 2 with some fields', async function () {
    this.timeout(60_000)

    const attributes = {
      targetUrl: ImportsCommand.getYoutubeVideoUrl(),
      channelId: channelIdServer2,
      privacy: VideoPrivacy.PUBLIC,
      category: 10,
      licence: 7,
      language: 'en',
      name: 'my super name',
      description: 'my super description',
      tags: [ 'supertag1', 'supertag2' ]
    }
    const { video } = await servers[1].importsCommand.importVideo({ attributes })
    expect(video.name).to.equal('my super name')
  })

  it('Should have the videos listed on the two instances', async function () {
    this.timeout(120_000)

    await waitJobs(servers)

    for (const server of servers) {
      const res = await getVideosList(server.url)
      expect(res.body.total).to.equal(4)
      expect(res.body.data).to.have.lengthOf(4)

      await checkVideoServer2(server, res.body.data[0].uuid)

      const [ , videoHttp, videoMagnet, videoTorrent ] = res.body.data
      await checkVideosServer1(server, videoHttp.uuid, videoMagnet.uuid, videoTorrent.uuid)
    }
  })

  it('Should import a video that will be transcoded', async function () {
    this.timeout(120_000)

    const attributes = {
      name: 'transcoded video',
      magnetUri: ImportsCommand.getMagnetURI(),
      channelId: channelIdServer2,
      privacy: VideoPrivacy.PUBLIC
    }
    const { video } = await servers[1].importsCommand.importVideo({ attributes })
    const videoUUID = video.uuid

    await waitJobs(servers)

    for (const server of servers) {
      const res = await getVideo(server.url, videoUUID)
      const video: VideoDetails = res.body

      expect(video.name).to.equal('transcoded video')
      expect(video.files).to.have.lengthOf(4)
    }
  })

  it('Should import no HDR version on a HDR video', async function () {
    this.timeout(120_000)

    const config = {
      transcoding: {
        enabled: true,
        resolutions: {
          '240p': false,
          '360p': false,
          '480p': false,
          '720p': false,
          '1080p': true, // the resulting resolution shouldn't be higher than this, and not vp9.2/av01
          '1440p': false,
          '2160p': false
        },
        webtorrent: { enabled: true },
        hls: { enabled: false }
      },
      import: {
        videos: {
          http: {
            enabled: true
          },
          torrent: {
            enabled: true
          }
        }
      }
    }
    await servers[0].configCommand.updateCustomSubConfig({ newConfig: config })

    const attributes = {
      name: 'hdr video',
      targetUrl: ImportsCommand.getYoutubeHDRVideoUrl(),
      channelId: channelIdServer1,
      privacy: VideoPrivacy.PUBLIC
    }
    const { video: videoImported } = await servers[0].importsCommand.importVideo({ attributes })
    const videoUUID = videoImported.uuid

    await waitJobs(servers)

    // test resolution
    const res2 = await getVideo(servers[0].url, videoUUID)
    const video: VideoDetails = res2.body
    expect(video.name).to.equal('hdr video')
    const maxResolution = Math.max.apply(Math, video.files.map(function (o) { return o.resolution.id }))
    expect(maxResolution, 'expected max resolution not met').to.equals(VideoResolution.H_1080P)
  })

  after(async function () {
    await cleanupTests(servers)
  })
})
