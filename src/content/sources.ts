import type { ContentSource, UrlRule, VoaLessonContract } from './pipeline-types'

const verifiedAt = Date.UTC(2026, 8, 8)
const ccEvidence = 'https://creativecommons.org/licenses/by-sa/4.0/'
const jbEvidence = 'https://www.jupiterbroadcasting.com/'
const podhomeAccount = '/f01a19c0-6f9d-4aef-9515-08dc15242149/'
const rule = (origin: string, pathPrefix = '/'): UrlRule => ({ origin, pathPrefix })
const rights = (publisher: string, evidence: string): ContentSource['rights'] => ({
  status: 'verified', license: 'CC-BY-SA-4.0', evidenceUrls: [evidence, ccEvidence],
  attribution: publisher,
  scope: 'Publisher-owned show content only; exclude unlicensed clips, music, ads and other third-party material. Attribute creator, episode and license, indicate excerpting/transcription and preserve ShareAlike.',
  stream: true, excerpt: true, transcribe: true, storeAudio: true, redistribute: true,
  shareAlike: true, recheckAfterDays: 90,
})

/** Trusted server configuration. Incoming feeds cannot add/enable sources or URL rules. */
const RSS_CONTENT_SOURCES: readonly ContentSource[] = [
  {
    id: 'jb-the-launch', name: 'The Launch', enabled: true,
    feedUrl: 'https://serve.podhome.fm/rss/04b078f9-b3e8-4363-a576-98e668231306',
    homepage: 'https://www.weeklylaunch.rocks', publisher: 'Jupiter Broadcasting',
    topics: ['Everyday life', 'Technology', 'Culture'], declaredLanguage: 'en',
    cadenceHours: 24, verifiedAt, rights: rights('Jupiter Broadcasting', jbEvidence),
    urls: {
      feed: [rule('https://serve.podhome.fm', '/rss/04b078f9-b3e8-4363-a576-98e668231306')],
      page: [rule('https://www.weeklylaunch.rocks', '/episodepage/')],
      audio: [
        rule('https://op3.dev', '/e/serve.podhome.fm/episode/f01a19c0-6f9d-4aef-9515-08dc15242149/'),
        rule('https://serve.podhome.fm', '/episode/f01a19c0-6f9d-4aef-9515-08dc15242149/'),
        rule('https://assets.podhome.fm', podhomeAccount),
      ],
      transcript: [rule('https://assets.podhome.fm', podhomeAccount)],
    },
    transcriptDiscovery: 'podcasting2',
    examples: [{
      episodeUrl: 'https://www.weeklylaunch.rocks/episodepage/81',
      transcriptUrl: 'https://assets.podhome.fm/f01a19c0-6f9d-4aef-9515-08dc15242149/4a9d42f8-0479-41d1-a755-4cffec5b935a639233556252376400.vtt',
      format: 'vtt',
    }, {
      episodeUrl: 'https://www.weeklylaunch.rocks/episodepage/82',
      transcriptUrl: 'https://assets.podhome.fm/f01a19c0-6f9d-4aef-9515-08dc15242149/51e86b15-ada2-4f02-91b8-91755b90ea59639238907546110825.vtt',
      format: 'vtt',
    }],
    notes: [
      'Official subscription page: https://www.jupiterbroadcasting.com/show/the-launch/subscribe/. Feed returned HTTP 200; newest item September 2, 2026.',
      'Host conversation includes camping, home gadgets, hobbies and culture as well as technology. Screen actual excerpts; no claim of full life-scenario coverage.',
      'Feed supplies VTT, SRT and HTML. Only timed VTT/SRT are accepted. Third-party clips are a material rights risk; never pass them on the blanket show license.',
      'Episode 81 VTT and audio HEAD returned HTTP 200; 836 cues parsed. Episodes 82 and 80 have overlapping cues and are quarantined by this strict timing subset, not silently repaired.',
      'Human speech, accent, acoustic quality and caption alignment remain unknown until analyzed. Do not certify US accents from host location.',
    ],
  },
  {
    id: 'jb-linux-unplugged', name: 'LINUX Unplugged', enabled: true,
    feedUrl: 'https://feeds.jupiterbroadcasting.com/lup', homepage: 'https://linuxunplugged.com',
    publisher: 'Jupiter Broadcasting', topics: ['Technology', 'Work'], declaredLanguage: 'en-US',
    cadenceHours: 24, verifiedAt, rights: rights('Jupiter Broadcasting', jbEvidence),
    urls: {
      feed: [rule('https://feeds.jupiterbroadcasting.com', '/lup'), rule('https://linuxunplugged.com', '/rss')],
      page: [rule('https://linuxunplugged.com')],
      audio: [
        rule('https://dts.podtrac.com', '/redirect.mp3/mgln.ai/e/211/rss.art19.com/episodes/'),
        rule('https://mgln.ai', '/e/211/rss.art19.com/episodes/'),
        rule('https://rss.art19.com', '/episodes/'),
        rule('https://rss.art19.com', '/external/episodes/'),
        // Actual GET redirects (HEAD stops at ART19) verified September 8; no wildcard CDN or saved expiring URL.
        { ...rule('https://content.production.cdn.art19.com', '/'), pathShape: 'art19-signed-audio' },
      ],
      transcript: [rule('https://feeds.jupiterbroadcasting.com', '/transcripts/lup/')],
    },
    transcriptDiscovery: 'podcasting2',
    examples: [{
      episodeUrl: 'https://linuxunplugged.com/683',
      transcriptUrl: 'https://feeds.jupiterbroadcasting.com/transcripts/lup/bde88c71-5e5d-47ea-b5db-e7af0cd0e5ef.vtt',
      format: 'vtt',
    }],
    notes: [
      'Canonical RSS and sample VTT returned HTTP 200. Newest item September 6, 2026. The current full feed is about 9.2 MB; allow bounded 12 MiB feed intake and select a recent batch.',
      'Natural multi-host technical discussions are interest/transfer input, not beginner or daily-life coverage. Exclude ads, intros, music and unexplained technical passages.',
      'Audio redirect hosts above were present in the enclosure. Any additional CDN redirect must be verified and explicitly allowed by the backend before download.',
    ],
  },
  {
    id: 'hacker-public-radio', name: 'Hacker Public Radio', enabled: true,
    feedUrl: 'https://hackerpublicradio.org/hpr_ogg_rss.php', homepage: 'https://hackerpublicradio.org',
    publisher: 'Hacker Public Radio and the credited episode host',
    topics: ['Technology', 'Everyday life', 'Culture'], declaredLanguage: 'en-US',
    cadenceHours: 24, verifiedAt,
    rights: rights('Hacker Public Radio and episode host', 'https://hackerpublicradio.org/contribute.html'),
    urls: {
      feed: [rule('https://hackerpublicradio.org', '/hpr_ogg_rss.php')],
      page: [rule('https://hackerpublicradio.org', '/eps/')],
      audio: [{ ...rule('https://hub.hackerpublicradio.org', '/ccdn.php'), query: 'hpr-file' }, rule('https://hpr.nyc3.cdn.digitaloceanspaces.com', '/eps/'), rule('https://alpha.nl.eu.mirror.hackerpublicradio.org', '/eps/')],
      transcript: [{ ...rule('https://hub.hackerpublicradio.org', '/ccdn.php'), query: 'hpr-file' }, rule('https://hpr.nyc3.cdn.digitaloceanspaces.com', '/eps/'), rule('https://alpha.nl.eu.mirror.hackerpublicradio.org', '/eps/')],
    },
    transcriptDiscovery: 'hpr-srt',
    examples: [{
      episodeUrl: 'https://hackerpublicradio.org/eps/hpr4605/index.html',
      transcriptUrl: 'https://hub.hackerpublicradio.org/ccdn.php?filename=/eps/hpr4605/hpr4605.srt',
      format: 'srt',
    }],
    notes: [
      'RSS returned HTTP 200; newest item September 7, 2026. Episode page exposes the verified SRT pattern; the example returned HTTP 200 through the listed DigitalOcean CDN.',
      'The publisher CDN also returned HTTP 200 for hpr4721 SRT and Ogg. The narrow SRT fallback uses that stable CDN path; other mirror redirects still require allowlist checks.',
      'Hosts discuss hobbies and personal experiences as well as technology. Accent and English ability vary. Publisher explicitly does not review the complete audio; all candidates require our screening.',
      'The example is a wedding recording with quotations and imperfect captions, useful as a discovery example only, NOT an approved lesson. Prefer Podcasting 2.0 references if later introduced.',
      'Rotating mirrors outside the explicit rules are blocked. Ogg playback on target WebKit and any authorized transcode need backend/browser verification.',
    ],
  },
  {
    id: 'changelog-friends-disabled', name: 'Changelog & Friends', enabled: false,
    disabledReason: 'The live RSS states All rights reserved; no checked permission to adapt/transcribe/rehost. The CC statement on /terms licenses the terms document, not the shows.',
    feedUrl: 'https://changelog.com/friends/feed', homepage: 'https://changelog.com/friends',
    publisher: 'Changelog Media', topics: ['Technology'], declaredLanguage: 'en-US',
    cadenceHours: 168, verifiedAt,
    rights: {
      status: 'uncertain', license: 'unknown', evidenceUrls: ['https://changelog.com/terms', 'https://changelog.com/friends/feed'],
      attribution: 'Changelog Media', scope: 'No content-ingestion permission verified.',
      stream: false, excerpt: false, transcribe: false, storeAudio: false, redistribute: false,
      shareAlike: false, recheckAfterDays: 90,
    },
    urls: { feed: [], page: [], audio: [], transcript: [] },
    transcriptDiscovery: 'podcasting2', examples: [],
    notes: ['Metadata-only research record. Not part of the ingestion allowlist; latest feed item seen May 13, 2026, so continuing supply is also uncertain.'],
  },
  {
    id: 'voa-everyday-grammar', name: 'VOA Everyday Grammar (archive supplement)', enabled: true,
    feedUrl: 'https://learningenglish.voanews.com/podcast/?zoneId=4456', homepage: 'https://learningenglish.voanews.com/z/4456',
    publisher: 'VOA Learning English', topics: ['Everyday life', 'Work', 'Culture'], declaredLanguage: 'en-US',
    cadenceHours: 168, supply: 'archive-supplement', verifiedAt,
    rights: {
      status: 'verified', license: 'VOA-public-domain', evidenceUrls: ['https://learningenglish.voanews.com/p/6021.html'],
      attribution: 'Voice of America / learningenglish.voanews.com',
      scope: 'Only text and audio exclusively produced by VOA, as stated by its current Copyright Statement. Exclude AP, licensed music, movie clips, quotations/recordings and any other third-party works; the publisher policy does not grant those rights. Do not reuse logos or imply endorsement.',
      stream: true, excerpt: true, transcribe: true, storeAudio: true, redistribute: true, shareAlike: false, recheckAfterDays: 90,
    },
    urls: { feed: [{ origin: 'https://learningenglish.voanews.com', pathPrefix: '/podcast/', query: 'voa-zone' }],
      page: [rule('https://learningenglish.voanews.com','/a/')], audio: [rule('https://voa-audio.voanews.eu','/vle/')], transcript: [] },
    transcriptDiscovery: 'podcasting2', examples: [],
    notes: [
      'Official podcast directory https://learningenglish.voanews.com/podcasts links this exact RSS; fetched HTTP 200 with 235044 characters on September 8, 2026.',
      'Newest item March 12, 2025: https://learningenglish.voanews.com/a/8008295.html ; audio https://voa-audio.voanews.eu/vle/2025/03/12/8c84c8e5-a3ba-4d8f-0d65-08dd5c8d307c_original.mp3 (5685248 publisher bytes). This is an ARCHIVE, not claimed fresh daily supply.',
      'Educational US English includes dialogue examples and daily-life language, supplementing the current technical feeds. It is not a complete real-life-mission library or fully spontaneous conversation corpus.',
      'Current RSS has no timed transcripts. Use actual audio STT plus independent audio screening; do not invent timed captions from article prose. No per-episode acoustic or third-party clearance has yet been obtained.',
    ],
  },
]

/** Public sample only: the separate 1000-hour corpus is NOT covered by this CC license. */
export const OPEN_YAP_SAMPLE_SOURCE: ContentSource = {
  id: 'open-yap-sample', name: 'Open Yap natural everyday conversations (public sample)', enabled: true,
  feedUrl: 'https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/raw/main/preview/metadata.jsonl',
  feedFormat: 'open-yap-preview-jsonl', homepage: 'https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k',
  publisher: 'The Agentic Data Company', topics: ['Everyday life', 'Living abroad', 'Work', 'Culture'],
  declaredLanguage: 'en', cadenceHours: 168, supply: 'archive-supplement', verifiedAt,
  rights: {
    status: 'verified', license: 'CC-BY-4.0',
    evidenceUrls: ['https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/raw/main/LICENSE.txt'],
    attribution: 'The Agentic Data Company — Open Yap 1K public sample, CC BY 4.0; excerpted and transcribed for language practice. Respect the accompanying request: no speaker identification or identifiable voice cloning.',
    scope: 'Only the first-party public sample/preview recordings covered by LICENSE.txt. Publisher states conversation-specific consent for publication. Exclude the separately requested full corpus under its Data Use Agreement and any third-party recordings/music. Retain attribution, license/rider and modification notices. Do not identify speakers or create voice clones.',
    stream: true, excerpt: true, transcribe: true, storeAudio: true, redistribute: true, shareAlike: false, recheckAfterDays: 90,
  },
  urls: {
    feed: [rule('https://huggingface.co', '/datasets/TheAgenticDataCompany/open-yap-1k/raw/main/preview/metadata.jsonl')],
    page: [{ origin: 'https://huggingface.co', pathPrefix: '/datasets/TheAgenticDataCompany/open-yap-1k/blob/main/preview/', pathShape: 'open-yap-preview' }],
    audio: [
      { origin: 'https://huggingface.co', pathPrefix: '/datasets/TheAgenticDataCompany/open-yap-1k/resolve/main/preview/', pathShape: 'open-yap-preview' },
      { origin: 'https://us.aws.cdn.hf.co', pathPrefix: '/xet-bridge-us/6a97e8aabe471b1b359f7cd6/', pathShape: 'open-yap-cdn' },
    ], transcript: [],
  },
  transcriptDiscovery: 'none-stt', examples: [],
  notes: [
    'First-party LICENSE.txt and preview/metadata.jsonl fetched September 8, 2026. Public sample: 16 real friends/family conversations, 8.9 hours, not claimed recurring newly recorded supply. Scheduled conditional polling detects changes to this exact manifest; existing RSS feeds continue separately.',
    'Core topics in publisher metadata: daily routines, travel planning, visa/paperwork, cooking, relocation, family/social life, shopping, work and household activities. These tags guide discovery, not certified interval coverage or General American quality.',
    'Preview MP3s are 16–71 MB; downloads over the 64MiB job ceiling fail closed. Exact measured clip bytes use the existing MPEG-frame/preroll pipeline. No time-proportional byte cutting.',
    'Word-level machine transcripts are described for separate ~1GB tar shards; no matching standalone public-preview timed transcript has been verified. Do not bulk-download them or assert alignment with the mixed MP3 preview. Authorized STT plus real audio screening required.',
    'Publisher self-reports native speakers, conversation-specific consent and human QA; this does NOT instantiate local observed inspection facts or approve a lesson. All collected items initially await real audio analysis.',
  ],
}

export const CONTENT_SOURCES: readonly ContentSource[] = [...RSS_CONTENT_SOURCES, OPEN_YAP_SAMPLE_SOURCE]
export const ALLOWLISTED_CONTENT_SOURCES = CONTENT_SOURCES.filter(source => source.enabled && source.rights.status === 'verified')

/** Bounded first-party scene audit. These are NOT extra feeds or approved lessons. */
export const VOA_LESSON_CANDIDATES: readonly VoaLessonContract[] = [
  { id: 'voa-lle-neighborhood', title: 'This Is My Neighborhood', mediaId: '3294378',
    pageUrl: 'https://learningenglish.voanews.com/a/lets-learn-english-lesson-11-this-is-my-neighborhood/3293986.html',
    audioUrl: 'https://voa-audio.voanews.eu/vle/2016/04/20/de238e35-97b9-4c21-81e3-e3c26fbeccaa.mp3',
    potentialTasks: ['ask for directions', 'ask for everyday help', 'neighborhood errands'],
    limitations: ['Mentions finding a bank and getting cash, NOT opening an account or a teller transaction.',
      'Apartment location is NOT renting or negotiating a lease. No published timed captions verified.',
      'Scripted VOA teaching scene; exact audio still needs human-speech, music/third-party and timing inspection.'] },
  { id: 'voa-lle-interview', title: 'The Interview', mediaId: '4016512',
    pageUrl: 'https://learningenglish.voanews.com/a/lets-learn-english-level-2-lesson-2/3960471.html',
    audioUrl: 'https://voa-audio.voanews.eu/vle/2017/09/05/676d9800-cee0-4a59-9e79-b9378e0061ad.mp3',
    potentialTasks: ['job interview', 'discuss work skills', 'clarify an assignment'],
    limitations: ['Comedic scripted interview is a candidate, not comprehensive job preparation or a certified real interview.',
      'Professor Bot teaching interludes may not qualify as primary human input; select only actual inspected dialogue.',
      'No published timed captions verified. Background/inserted audio rights and whole-interval alignment remain unknown.'] },
  { id: 'voa-lle-help', title: 'How Can I Help?', mediaId: '3748838',
    pageUrl: 'https://learningenglish.voanews.com/a/lets-learn-english-lesson-47-how-can-i-help/3737352.html',
    audioUrl: 'https://voa-audio.voanews.eu/vle/2017/03/03/8511524b-9e6f-4e73-9fa1-cd3f6b32b495.mp3',
    potentialTasks: ['offer practical help', 'ask for clarification', 'cooperate on a problem'],
    limitations: ['Contains an in-story online course and Master interlude: their exact audio ownership/music cannot be inferred from the VOA label.',
      'Not emergency assistance or verified mechanical advice. Keep disabled until exact interval rights/audio review.',
      'No published timed captions verified; page script cannot supply invented timestamps.'] },
]

/** Bounded research queue, NOT ingestion configuration or approval. Never synthesize an RSS URL for these sites. */
export const CONTENT_SOURCE_RESEARCH = [
  {
    id: 'university-colima-unispeak-a2', enabled: false, checkedAt: verifiedAt,
    page: 'https://redi.ucol.mx/recurso/503',
    exampleAudio: 'https://redi.ucol.mx/storage/oas/503/metaFiles/RED_503_20250819200807.mp3',
    transcript: null, rightsEvidence: ['https://redi.ucol.mx/recurso/503'],
    fit: 'University-published A2 everyday English learning material; potential classroom dialogue supplement.',
    remaining: 'First-party page names authors and displays generic CC BY, without a verified exact license version. Linked MP3 exists, but human versus synthetic speech and a reliably aligned transcript are unverified; metadata endpoint returned 404. Not enabled or counted as approved human content.',
  },
  {
    id: 'state-everyday-conversations', enabled: false, checkedAt: verifiedAt,
    page: 'https://americanenglish.state.gov/resources/everyday-conversations-learning-american-english',
    exampleAudio: 'https://americanenglish.state.gov/files/ae/resource_files/dialogue_2-01_ordering_a_meal.mp3',
    transcript: 'https://americanenglish.state.gov/files/ae/resource_files/b_dialogues_everyday_conversations_english_lo_0.pdf',
    rightsEvidence: ['https://www.state.gov/copyright-information/', 'https://2021-2025.state.gov/copyright-information/'],
    fit: 'US-authored everyday dialogues: introductions, clarification, restaurant, shopping, transport, advice and social life. Core supplement, not a continuing RSS supply.',
    remaining: 'Official resource page reachable with MP3/PDF links. Current policy endpoint returned 403; archived publisher policy permits unmarked government works but individual audio/third-party exclusions still need verification. No audio listening, exact transcript extraction or timed alignment completed. Not enabled.',
  },
  {
    id: 'elllo-conversations', enabled: false, checkedAt: verifiedAt,
    page: 'https://www.elllo.org/guide/index.htm',
    exampleAudio: null, transcript: 'https://www.elllo.org/english/0151/153-Matt-Manchester.htm',
    rightsEvidence: ['https://www.elllo.org/about/faq.htm', 'https://www.elllo.org/english/Mixers/?D=A', 'https://www.elllo.org/english/0151/153-Matt-Manchester.htm'],
    fit: 'Natural daily-life conversations at multiple levels and with varied speakers; strong potential core coverage.',
    remaining: 'Current primary FAQ permits classroom/LMS uses. A still-reachable old primary Mixer index says MP3/text are Creative Commons for noncommercial educational copying/distribution, but gives no exact applicable version or adaptation/STT permission. Newer lesson has copyright notice. Resolve this specific license scope, not a blanket CC assumption; no crawl or RSS URL invented.',
  },
] as const
