import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/database'
import { assetsRoot } from '../services/assetService'

type DemoVideo = {
  code: string
  title: string
  originalTitle: string
  summary: string
  cover: string
  releaseDate: string
  maker: string
  publisher: string
  series: string
  director: string
  duration: number
  rating: number
  tags: string[]
  creators: string[]
}

const DEMO_VIDEOS: DemoVideo[] = [
  {
    code: 'NOR-101',
    title: '灯塔档案：海岸线的微光',
    originalTitle: 'Lighthouse Notes: Coastline After Blue Hour',
    summary: '一段沿海观察计划留下的录音、航线图与灯塔值守笔记，被整理成关于风、潮汐与远方来信的短片。',
    cover: 'coastline.svg',
    releaseDate: '2025-09-18',
    maker: '北纬工作室',
    publisher: '微光档案',
    series: '海岸观察',
    director: '沈遥',
    duration: 3120,
    rating: 4.4,
    tags: ['自然观察', '声音采集', '旅行随笔'],
    creators: ['林澈', '周岚']
  },
  {
    code: 'ARC-204',
    title: '折光花园',
    originalTitle: 'The Refracted Garden',
    summary: '建筑师与园艺师在旧玻璃温室里重建一座可漫步的光谱花园，记录季节、材料与手作之间的细小变化。',
    cover: 'garden.svg',
    releaseDate: '2025-11-06',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 2760,
    rating: 4.7,
    tags: ['建筑设计', '植物', '艺术纪录'],
    creators: ['周岚', '谢遥']
  },
  {
    code: 'MTR-317',
    title: '夜班列车的十六分钟',
    originalTitle: 'Sixteen Minutes on the Last Train',
    summary: '末班地铁驶过高架与旧城区，镜头收集车窗倒影、站台广播和一座城市在夜色里的呼吸。',
    cover: 'metro.svg',
    releaseDate: '2026-01-22',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 960,
    rating: 4.2,
    tags: ['城市漫游', '铁路', '环境音乐'],
    creators: ['谢遥']
  },
  {
    code: 'NOR-118',
    title: '潮间带的颜色练习',
    originalTitle: 'Studies in Intertidal Color',
    summary: '在退潮后的礁石之间，创作者以颜料、标本和日记重建一天内不断变化的海岸色谱。',
    cover: 'coastline.svg',
    releaseDate: '2026-02-14',
    maker: '北纬工作室',
    publisher: '缓慢放映',
    series: '海岸观察',
    director: '林澈',
    duration: 2280,
    rating: 4.5,
    tags: ['自然观察', '视觉艺术', '手作'],
    creators: ['林澈']
  },
  {
    code: 'ARC-226',
    title: '玻璃屋的第二个春天',
    originalTitle: 'A Second Spring for the Glasshouse',
    summary: '一座停用多年的社区温室重新打开，陌生人带来种子、故事与各自对公共空间的想象。',
    cover: 'garden.svg',
    releaseDate: '2026-03-03',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 2940,
    rating: 4.3,
    tags: ['社区', '植物', '人物访谈'],
    creators: ['周岚', '林澈']
  },
  {
    code: 'MTR-330',
    title: '沿河站台',
    originalTitle: 'Platform by the River',
    summary: '雨后黄昏，列车、河面与桥下的爵士乐练习交错出现，成为一封写给日常通勤的安静情书。',
    cover: 'metro.svg',
    releaseDate: '2026-04-12',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 2460,
    rating: 4.6,
    tags: ['城市漫游', '雨夜', '音乐现场'],
    creators: ['谢遥', '周岚']
  }
]

const EXTRA_DEMO_VIDEOS: DemoVideo[] = [
  {
    code: 'NOR-126',
    title: '盐雾与小信号',
    originalTitle: 'Salt Mist, Small Signals',
    summary: '沿着防波堤布置的无线电接收器，捕捉到海鸟、渔船和天气站之间短暂而清晰的对话。',
    cover: 'coastline.svg',
    releaseDate: '2026-04-28',
    maker: '北纬工作室',
    publisher: '微光档案',
    series: '海岸观察',
    director: '沈遥',
    duration: 1980,
    rating: 4.1,
    tags: ['自然观察', '无线电', '声音采集'],
    creators: ['林澈', '谢遥']
  },
  {
    code: 'ARC-238',
    title: '屋顶的气候试验',
    originalTitle: 'A Roof for Weather Experiments',
    summary: '一群学生用废弃材料搭起微型气候花园，观察雨水、苔藓和风向如何改变一座楼顶。',
    cover: 'garden.svg',
    releaseDate: '2026-05-06',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 2520,
    rating: 4.4,
    tags: ['建筑设计', '社区', '气候'],
    creators: ['周岚', '林澈']
  },
  {
    code: 'MTR-341',
    title: '环线终点之后',
    originalTitle: 'Beyond the Circle Line',
    summary: '列车结束运营后，司机沿空车路线回库；车厢灯光、隧道回声与清晨第一班车交替出现。',
    cover: 'metro.svg',
    releaseDate: '2026-05-19',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 1860,
    rating: 4.3,
    tags: ['城市漫游', '铁路', '清晨'],
    creators: ['谢遥']
  },
  {
    code: 'NOR-133',
    title: '海图上的空白处',
    originalTitle: 'Blank Spaces on a Sea Chart',
    summary: '一张旧海图边缘的注记，引出三代测绘员关于方向、记忆与海岸变化的访谈。',
    cover: 'coastline.svg',
    releaseDate: '2026-05-30',
    maker: '北纬工作室',
    publisher: '缓慢放映',
    series: '海岸观察',
    director: '林澈',
    duration: 3300,
    rating: 4.8,
    tags: ['旅行随笔', '人物访谈', '地图'],
    creators: ['林澈', '周岚']
  },
  {
    code: 'ARC-249',
    title: '花房的夜间排练',
    originalTitle: 'Night Rehearsal in the Conservatory',
    summary: '温室在闭馆后成为一座临时舞台，灯光设计、植物呼吸与排练的节奏被细致地编织在一起。',
    cover: 'garden.svg',
    releaseDate: '2026-06-08',
    maker: '折页映像',
    publisher: '缓慢放映',
    series: '城市绿洲',
    director: '周岚',
    duration: 2340,
    rating: 4.5,
    tags: ['艺术纪录', '植物', '表演'],
    creators: ['周岚', '谢遥']
  },
  {
    code: 'MTR-356',
    title: '桥下录音棚',
    originalTitle: 'Studio Under the Viaduct',
    summary: '桥下的排练室迎来不同乐手，城市的低频、雨水与乐器的泛音共同构成一次现场录音。',
    cover: 'metro.svg',
    releaseDate: '2026-06-14',
    maker: '远行制片社',
    publisher: '微光档案',
    series: '夜行城市',
    director: '谢遥',
    duration: 2160,
    rating: 4.6,
    tags: ['音乐现场', '城市漫游', '雨夜'],
    creators: ['谢遥', '林澈']
  },
  {
    code: 'NOR-140',
    title: '退潮后的石头剧场',
    originalTitle: 'The Stone Theatre at Low Tide',
    summary: '退潮露出的礁石形成天然剧场，孩子们在这里讲述海岸传说，也学习辨认潮池里的生命。',
    cover: 'coastline.svg',
    releaseDate: '2026-06-21',
    maker: '北纬工作室',
    publisher: '微光档案',
    series: '海岸观察',
    director: '沈遥',
    duration: 2700,
    rating: 4.2,
    tags: ['自然观察', '社区', '声音采集'],
    creators: ['林澈']
  },
  {
    code: 'ARC-260',
    title: '从窗台开始的森林',
    originalTitle: 'A Forest Begins on the Sill',
    summary: '十二扇窗台上的植物实验串起不同住户的生活节奏，微小的绿意逐渐连接成一张邻里地图。',
    cover: 'garden.svg',
    releaseDate: '2026-06-27',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '林澈',
    duration: 2880,
    rating: 4.7,
    tags: ['植物', '社区', '视觉艺术'],
    creators: ['林澈', '周岚']
  },
  {
    code: 'MTR-368',
    title: '第三月台的蓝色时刻',
    originalTitle: 'Blue Hour at Platform Three',
    summary: '晚班车抵达前的短暂空隙里，站务员、清洁工与等车的人各自拥有一段安静的时间。',
    cover: 'metro.svg',
    releaseDate: '2026-07-02',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 2040,
    rating: 4.4,
    tags: ['铁路', '人物访谈', '环境音乐'],
    creators: ['谢遥', '周岚']
  },
  {
    code: 'NOR-147',
    title: '北风写给灯塔的信',
    originalTitle: 'Letters the North Wind Left',
    summary: '研究员整理多年来的气象记录，并把那些无人寄出的海上来信读给即将停用的灯塔。',
    cover: 'coastline.svg',
    releaseDate: '2026-07-07',
    maker: '北纬工作室',
    publisher: '缓慢放映',
    series: '海岸观察',
    director: '沈遥',
    duration: 3180,
    rating: 4.9,
    tags: ['旅行随笔', '声音采集', '人物访谈'],
    creators: ['林澈', '谢遥']
  },
  {
    code: 'ARC-272',
    title: '雨水收集器',
    originalTitle: 'The Rain Collector',
    summary: '一次针对老旧街区的雨水改造，带来新的种植空间，也让居民重新认识屋檐下的公共生活。',
    cover: 'garden.svg',
    releaseDate: '2026-07-11',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 2400,
    rating: 4.3,
    tags: ['建筑设计', '气候', '社区'],
    creators: ['周岚']
  },
  {
    code: 'MTR-379',
    title: '末班车之后的河流',
    originalTitle: 'The River After the Last Train',
    summary: '镜头从列车末端离开，转向夜间河面与桥梁；城市的交通网在水光中慢慢退到背景。',
    cover: 'metro.svg',
    releaseDate: '2026-07-16',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 2580,
    rating: 4.6,
    tags: ['城市漫游', '雨夜', '旅行随笔'],
    creators: ['谢遥', '林澈']
  }
]

const MORE_DEMO_VIDEOS: DemoVideo[] = [
  {
    code: 'NOR-155',
    title: '海风测量站',
    originalTitle: 'The Station That Measures Wind',
    summary: '废弃观测站重新亮灯，年轻研究员用风筝、纸带与旧仪器记录海风穿过岬角时留下的轨迹。',
    cover: 'coastline.svg',
    releaseDate: '2026-07-18',
    maker: '北纬工作室',
    publisher: '微光档案',
    series: '海岸观察',
    director: '沈遥',
    duration: 2220,
    rating: 4.5,
    tags: ['自然观察', '气候', '声音采集'],
    creators: ['林澈', '谢遥']
  },
  {
    code: 'ARC-281',
    title: '会呼吸的砖墙',
    originalTitle: 'The Wall That Learned to Breathe',
    summary: '设计师在旧厂房墙面种下耐阴植物，让光、湿度和砖缝共同塑造一块缓慢生长的立面。',
    cover: 'garden.svg',
    releaseDate: '2026-07-20',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 2640,
    rating: 4.6,
    tags: ['建筑设计', '植物', '气候'],
    creators: ['周岚']
  },
  {
    code: 'MTR-386',
    title: '凌晨四点的换乘厅',
    originalTitle: 'Transfer Hall at Four',
    summary: '首班车到来以前，巨大的换乘厅只剩维护灯、自动扶梯与几位夜班工人的脚步声。',
    cover: 'metro.svg',
    releaseDate: '2026-07-22',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 1740,
    rating: 4.3,
    tags: ['城市漫游', '铁路', '清晨'],
    creators: ['谢遥']
  },
  {
    code: 'NOR-163',
    title: '浮标之间的航线',
    originalTitle: 'A Route Between the Buoys',
    summary: '小船沿着一串旧浮标前进，重新核对港湾里被季风和潮汐不断改写的安全航线。',
    cover: 'coastline.svg',
    releaseDate: '2026-07-24',
    maker: '北纬工作室',
    publisher: '缓慢放映',
    series: '海岸观察',
    director: '林澈',
    duration: 2880,
    rating: 4.7,
    tags: ['旅行随笔', '地图', '自然观察'],
    creators: ['林澈']
  },
  {
    code: 'ARC-293',
    title: '旧影院的植物灯',
    originalTitle: 'Grow Lights in the Old Cinema',
    summary: '停映后的社区影院被改造成育苗空间，银幕前的灯光为种子和邻里活动重新排出时间表。',
    cover: 'garden.svg',
    releaseDate: '2026-07-26',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 3060,
    rating: 4.8,
    tags: ['社区', '植物', '艺术纪录'],
    creators: ['周岚', '林澈']
  },
  {
    code: 'MTR-394',
    title: '隧道里的微型天气',
    originalTitle: 'Small Weather Underground',
    summary: '工程师沿地铁隧道测量温差和气流，把不可见的地下天气绘制成一组发光的动态图谱。',
    cover: 'metro.svg',
    releaseDate: '2026-07-28',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 2100,
    rating: 4.4,
    tags: ['铁路', '气候', '视觉艺术'],
    creators: ['谢遥', '周岚']
  },
  {
    code: 'NOR-171',
    title: '岛屿邮差的星期三',
    originalTitle: "The Island Postman's Wednesday",
    summary: '邮差每周乘渡船走过三座小岛，信件、补给与天气消息在同一条航线上抵达不同的人家。',
    cover: 'coastline.svg',
    releaseDate: '2026-07-30',
    maker: '北纬工作室',
    publisher: '微光档案',
    series: '海岸观察',
    director: '沈遥',
    duration: 3360,
    rating: 4.9,
    tags: ['人物访谈', '旅行随笔', '社区'],
    creators: ['林澈', '周岚']
  },
  {
    code: 'ARC-305',
    title: '天井里的雨季',
    originalTitle: 'Monsoon in the Courtyard',
    summary: '老公寓的住户用陶罐、竹管和遮雨布重新组织天井，让漫长雨季成为共享的声音装置。',
    cover: 'garden.svg',
    releaseDate: '2026-08-01',
    maker: '折页映像',
    publisher: '缓慢放映',
    series: '城市绿洲',
    director: '林澈',
    duration: 2460,
    rating: 4.5,
    tags: ['建筑设计', '雨夜', '声音采集'],
    creators: ['林澈', '周岚']
  },
  {
    code: 'MTR-402',
    title: '高架尽头的电影院',
    originalTitle: 'Cinema at the End of the Line',
    summary: '废弃站房在周末变成一间小电影院，列车余响与老胶片的放映声在高架尽头相遇。',
    cover: 'metro.svg',
    releaseDate: '2026-08-03',
    maker: '远行制片社',
    publisher: '微光档案',
    series: '夜行城市',
    director: '谢遥',
    duration: 2820,
    rating: 4.7,
    tags: ['城市漫游', '艺术纪录', '铁路'],
    creators: ['谢遥', '林澈']
  },
  {
    code: 'NOR-184',
    title: '潮池里的星图',
    originalTitle: 'Constellations in a Tide Pool',
    summary: '夜间观察者用微距镜头记录潮池反射的星光，也辨认其中随水位出现和消失的细小生命。',
    cover: 'coastline.svg',
    releaseDate: '2026-08-05',
    maker: '北纬工作室',
    publisher: '缓慢放映',
    series: '海岸观察',
    director: '沈遥',
    duration: 1920,
    rating: 4.6,
    tags: ['自然观察', '视觉艺术', '夜空'],
    creators: ['林澈']
  },
  {
    code: 'ARC-318',
    title: '可移动的夏日厨房',
    originalTitle: 'A Kitchen That Follows Summer',
    summary: '一组折叠桌、遮阳篷与香草箱组成流动厨房，在不同街角收集食谱和关于夏天的记忆。',
    cover: 'garden.svg',
    releaseDate: '2026-08-07',
    maker: '折页映像',
    publisher: '微光档案',
    series: '城市绿洲',
    director: '周岚',
    duration: 2700,
    rating: 4.4,
    tags: ['社区', '手作', '植物'],
    creators: ['周岚', '谢遥']
  },
  {
    code: 'MTR-415',
    title: '雨幕中的信号灯',
    originalTitle: 'Signal Lights Through Rain',
    summary: '暴雨让郊区铁路暂时停运，信号员守在控制室里等待轨道、河道与天空重新恢复秩序。',
    cover: 'metro.svg',
    releaseDate: '2026-08-09',
    maker: '远行制片社',
    publisher: '缓慢放映',
    series: '夜行城市',
    director: '谢遥',
    duration: 2340,
    rating: 4.8,
    tags: ['铁路', '雨夜', '人物访谈'],
    creators: ['谢遥', '周岚']
  }
]

const ALL_DEMO_VIDEOS = [...DEMO_VIDEOS, ...EXTRA_DEMO_VIDEOS, ...MORE_DEMO_VIDEOS]
const DEMO_SEED_VERSION = '5'
const DEMO_SAMPLE_SOURCE = 'harbor-lights-film-still.png'
const DEMO_GALLERY_SOURCE = 'fictional-actor-portrait.png'

const CREATORS = [
  {
    name: '林澈',
    avatar: 'creator-lin.svg',
    gallery: 'creator-lin-gallery.png',
    bio: '独立摄影师，关注海岸生态与公共空间中的微小叙事。'
  },
  {
    name: '周岚',
    avatar: 'creator-zhou.svg',
    gallery: 'creator-zhou-gallery.png',
    bio: '空间设计师与纪录片创作者，以植物、材料和社区记忆为长期主题。'
  },
  {
    name: '谢遥',
    avatar: 'creator-xie.svg',
    gallery: 'creator-xie-gallery.png',
    bio: '声音采集者与剪辑师，记录城市夜行、交通与环境音乐。'
  }
]

const COVER_PALETTES = [
  ['#081c2c', '#155e75', '#f2c879', '#dff4ed'],
  ['#17102d', '#704264', '#ff9b71', '#fff0d7'],
  ['#102a24', '#477a62', '#e5c46b', '#eff5dc'],
  ['#28203d', '#496a9b', '#e9a66f', '#edf2ff'],
  ['#2b1720', '#9b4d51', '#efc26f', '#fff0e2'],
  ['#0f2a35', '#3d7b86', '#e28f70', '#e8f4ef'],
  ['#21192e', '#5d4b86', '#9ad0c2', '#f4e8c9'],
  ['#172721', '#66835a', '#f0ad68', '#eff0cf'],
  ['#151f36', '#35608a', '#e76e75', '#e5f1ef'],
  ['#2c1e19', '#8a6044', '#e8b85f', '#f5e7cf']
] as const

function demoCoverName(video: DemoVideo): string {
  return `${video.code.toLowerCase()}.svg`
}

function demoSampleName(video: DemoVideo): string {
  return `${video.code.toLowerCase()}-sample.png`
}

function escapeSvgText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escaped: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;'
    }
    return escaped[char]
  })
}

function coverArtwork(variant: number, accent: string, ink: string, seed: number): string {
  const shift = seed % 90
  switch (variant) {
    case 0:
      return `<circle cx="900" cy="388" r="218" fill="none" stroke="${accent}" stroke-width="22"/><circle cx="900" cy="388" r="126" fill="${accent}" opacity=".2"/><path d="M650 620 C780 430 980 680 1220 310" fill="none" stroke="${ink}" stroke-width="14" opacity=".75"/>`
    case 1:
      return `<path d="M650 650H790V540H920V430H1050V320H1210" fill="none" stroke="${ink}" stroke-width="38"/><circle cx="985" cy="255" r="92" fill="${accent}"/><path d="M730 170V690M850 150V690M970 170V690M1090 150V690" stroke="${accent}" stroke-width="8" opacity=".38"/>`
    case 2:
      return `<circle cx="965" cy="260" r="126" fill="${accent}" opacity=".9"/><path d="M580 500 C720 ${350 + shift} 850 ${620 - shift} 1010 470 S1200 430 1280 520V800H580Z" fill="${ink}" opacity=".38"/><path d="M585 590 C760 470 880 690 1050 545 S1210 520 1280 600" fill="none" stroke="${accent}" stroke-width="18"/>`
    case 3:
      return `<path d="M650 680V250Q650 130 770 130H1110Q1230 130 1230 250V680" fill="none" stroke="${ink}" stroke-width="28"/><path d="M780 680V310Q780 220 870 220H1010Q1100 220 1100 310V680" fill="${accent}" opacity=".28" stroke="${accent}" stroke-width="14"/><circle cx="940" cy="405" r="82" fill="${ink}" opacity=".75"/>`
    case 4:
      return `<path d="M570 250 C760 80 780 610 1010 250 S1190 390 1280 170" fill="none" stroke="${accent}" stroke-width="78" opacity=".8"/><path d="M590 560 C780 350 900 740 1130 470" fill="none" stroke="${ink}" stroke-width="28"/><circle cx="1100" cy="210" r="56" fill="${ink}"/>`
    case 5:
      return `<path d="M620 670V420H730V315H850V510H970V240H1090V385H1210V670Z" fill="${ink}" opacity=".76"/><path d="M680 470H705M785 380H815M1015 305H1045M1125 445H1160" stroke="${accent}" stroke-width="22"/><circle cx="800" cy="210" r="94" fill="${accent}" opacity=".75"/>`
    case 6:
      return `<path d="M920 690C890 520 900 350 980 150" fill="none" stroke="${ink}" stroke-width="20"/><ellipse cx="840" cy="480" rx="95" ry="180" fill="${accent}" transform="rotate(-38 840 480)"/><ellipse cx="1050" cy="360" rx="92" ry="170" fill="${ink}" opacity=".72" transform="rotate(34 1050 360)"/><ellipse cx="1010" cy="590" rx="78" ry="145" fill="${accent}" opacity=".72" transform="rotate(28 1010 590)"/>`
    case 7:
      return `<path d="M590 650L1230 260M600 740L1240 350" stroke="${ink}" stroke-width="34"/><path d="M670 610L750 705M820 515L900 610M970 420L1050 515M1120 325L1200 420" stroke="${accent}" stroke-width="20"/><rect x="820" y="225" width="300" height="170" rx="54" fill="${accent}" transform="rotate(-31 970 310)"/><circle cx="880" cy="390" r="36" fill="${ink}"/><circle cx="1070" cy="275" r="36" fill="${ink}"/>`
    case 8:
      return `<path d="M620 230C730 120 840 190 810 300S720 470 860 500 1050 400 1120 520 1040 690 900 660" fill="none" stroke="${ink}" stroke-width="24"/><path d="M660 280C760 210 780 320 740 390M900 170C1040 130 1170 220 1130 340M930 590C1010 510 1130 580 1190 690" fill="none" stroke="${accent}" stroke-width="14" opacity=".85"/><circle cx="860" cy="500" r="54" fill="${accent}"/>`
    default:
      return `<path d="M650 650L790 160 930 650Z" fill="${accent}" opacity=".75"/><path d="M820 650L1015 220 1210 650Z" fill="${ink}" opacity=".7"/><path d="M720 530L1120 330" stroke="${accent}" stroke-width="24"/><circle cx="1040" cy="180" r="78" fill="${accent}" opacity=".75"/>`
  }
}

function renderDemoCover(video: DemoVideo, index: number): string {
  const palette = COVER_PALETTES[index % COVER_PALETTES.length]
  const [background, surface, accent, ink] = palette
  const title = escapeSvgText(video.title)
  const originalTitle = escapeSvgText(video.originalTitle.toUpperCase().slice(0, 34))
  const code = escapeSvgText(video.code)
  const series = escapeSvgText(video.series)
  const gradientId = `cover-${video.code.toLowerCase()}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="${surface}"/></linearGradient>
    <filter id="grain-${index}"><feTurbulence baseFrequency=".8" numOctaves="2" seed="${index + 3}" type="fractalNoise"/><feComposite in="SourceGraphic" operator="in"/></filter>
  </defs>
  <rect width="1200" height="800" fill="url(#${gradientId})"/>
  <rect width="1200" height="800" fill="#fff" opacity=".035" filter="url(#grain-${index})"/>
  <path d="M540 0H1200V800H470Z" fill="#000" opacity=".09"/>
  <g>${coverArtwork(index % 10, accent, ink, index * 17 + 11)}</g>
  <text x="72" y="92" fill="${accent}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" letter-spacing="5">${series}</text>
  <text x="72" y="538" fill="${ink}" font-family="Arial, 'PingFang SC', sans-serif" font-size="48" font-weight="700">${title}</text>
  <text x="74" y="588" fill="${ink}" opacity=".72" font-family="Arial, Helvetica, sans-serif" font-size="18" letter-spacing="2">${originalTitle}</text>
  <line x1="72" y1="644" x2="470" y2="644" stroke="${accent}" stroke-width="5"/>
  <text x="72" y="714" fill="${accent}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" letter-spacing="5">${code}</text>
</svg>`
}

function demoResourceDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'demo'),
    path.join(process.cwd(), 'resources', 'demo')
  ]
  return candidates.find((dir) => fs.existsSync(dir)) ?? null
}

function copyDemoAssets(): void {
  const sourceDir = demoResourceDir()
  if (!sourceDir) throw new Error('演示素材目录不存在')
  const root = assetsRoot()
  for (const folder of ['covers', 'avatars', 'samples', 'actress_gallery']) {
    fs.mkdirSync(path.join(root, folder), { recursive: true })
  }

  const generatedDir = path.join(sourceDir, 'generated')
  for (const [index, video] of ALL_DEMO_VIDEOS.entries()) {
    const coverDestination = path.join(root, 'covers', demoCoverName(video))
    if (!fs.existsSync(coverDestination)) {
      fs.writeFileSync(coverDestination, renderDemoCover(video, index), 'utf8')
    }
    const sampleDestination = path.join(root, 'samples', demoSampleName(video))
    if (!fs.existsSync(sampleDestination)) {
      fs.copyFileSync(path.join(generatedDir, DEMO_SAMPLE_SOURCE), sampleDestination)
    }
  }
  for (const creator of CREATORS) {
    const avatarDestination = path.join(root, 'avatars', creator.avatar)
    if (!fs.existsSync(avatarDestination)) {
      fs.copyFileSync(path.join(sourceDir, creator.avatar), avatarDestination)
    }
    const galleryDestination = path.join(root, 'actress_gallery', creator.gallery)
    if (!fs.existsSync(galleryDestination)) {
      fs.copyFileSync(path.join(generatedDir, DEMO_GALLERY_SOURCE), galleryDestination)
    }
  }
}

/** Reset only the isolated demo data when the fixture version changes. */
export function prepareDemoUserData(): void {
  if (process.env.JAVDEX_DEMO_MODE !== '1') return
  const userData = app.getPath('userData')
  const markerPath = path.join(userData, '.demo-seed-version')
  const currentVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : ''
  if (currentVersion === DEMO_SEED_VERSION) return

  for (const name of ['data', 'media_assets', 'demo_media']) {
    fs.rmSync(path.join(userData, name), { recursive: true, force: true })
  }
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(markerPath, DEMO_SEED_VERSION, 'utf8')
}

function createDemoMediaFile(code: string): string {
  const dir = path.join(app.getPath('userData'), 'demo_media')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${code}.mp4`)
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, 'Javdex demo media placeholder\n')
  return filePath
}

/** Seed a separate, fully fictional library used only by `npm run dev:demo`. */
export function seedDemoLibrary(): void {
  if (process.env.JAVDEX_DEMO_MODE !== '1') return

  const db = getDb()
  const count = db.prepare('SELECT COUNT(*) AS count FROM videos').get() as { count: number }
  if (count.count > 0) return

  copyDemoAssets()
  const now = new Date().toISOString()
  db.transaction(() => {
    const creatorIds = new Map<string, number>()
    for (const creator of CREATORS) {
      const result = db
        .prepare(
          `INSERT INTO actresses
           (main_name, avatar_path, profile_summary, gender, last_scraped_at, updated_at)
           VALUES (?, ?, ?, 'female', ?, ?)`
        )
        .run(creator.name, `avatars/${creator.avatar}`, creator.bio, now, now)
      const creatorId = Number(result.lastInsertRowid)
      creatorIds.set(creator.name, creatorId)
      db.prepare(
        `INSERT INTO actress_names (actress_id, name, type, locale, source, is_primary)
         VALUES (?, ?, 'main', 'zh-CN', 'demo', 1)`
      ).run(creatorId, creator.name)
      db.prepare(
        `INSERT INTO actress_gallery_assets
         (actress_id, type, position, local_path, width, height, created_at)
         VALUES (?, 'gallery', 0, ?, 1024, 1536, ?)`
      ).run(creatorId, `actress_gallery/${creator.gallery}`, now)
    }

    const videoIds = new Map<string, number>()
    for (const video of ALL_DEMO_VIDEOS) {
      const coverName = demoCoverName(video)
      const videoResult = db
        .prepare(
          `INSERT INTO videos
           (code, title, original_title, summary, cover_path, poster_path, rating, release_date,
            maker, publisher, series, director, duration_seconds, scraped_status,
            last_scraped_at, updated_at, add_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          video.code,
          video.title,
          video.originalTitle,
          video.summary,
          `covers/${coverName}`,
          `covers/${coverName}`,
          Math.round(video.rating),
          video.releaseDate,
          video.maker,
          video.publisher,
          video.series,
          video.director,
          video.duration,
          now,
          now,
          video.releaseDate
        )
      const videoId = Number(videoResult.lastInsertRowid)
      videoIds.set(video.code, videoId)
      db.prepare(
        `INSERT INTO video_files
         (video_id, file_path, file_size, file_duration_seconds, is_primary, add_time)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).run(videoId, createDemoMediaFile(video.code), 128, video.duration, now)
      db.prepare(
        `INSERT INTO video_assets
         (video_id, type, position, local_path, width, height, is_primary, created_at)
         VALUES (?, 'sample', 0, ?, 1672, 941, 1, ?)`
      ).run(videoId, `samples/${demoSampleName(video)}`, now)
      db.prepare(
        `INSERT INTO video_external_stats (video_id, source, rating_average, rating_count, fetched_at)
         VALUES (?, 'Demo Archive', ?, ?, ?)`
      ).run(videoId, video.rating, 120 + videoId * 37, now)

      for (const tag of video.tags) {
        db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag)
        const tagId = (db.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number }).id
        db.prepare(
          `INSERT INTO video_tag (video_id, tag_id, origin, source, created_at)
           VALUES (?, ?, 'scraped', 'Demo Archive', ?)`
        ).run(videoId, tagId, now)
      }
      for (const creator of video.creators) {
        db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(
          videoId,
          creatorIds.get(creator)
        )
      }
      for (const [type, value] of [
        ['maker', video.maker],
        ['publisher', video.publisher],
        ['series', video.series],
        ['director', video.director]
      ]) {
        db.prepare('INSERT OR IGNORE INTO facet_entries (type, value) VALUES (?, ?)').run(type, value)
      }
    }

    const playlist = db
      .prepare(
        `INSERT INTO playlists (name, description, cover_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        '周末放映室',
        '三十部完全虚构的城市、自然与设计主题演示作品。',
        `covers/${demoCoverName(DEMO_VIDEOS[1])}`,
        now,
        now
      )
    const playlistId = Number(playlist.lastInsertRowid)
    for (const [position, code] of ['ARC-204', 'NOR-101', 'MTR-330'].entries()) {
      db.prepare(
        'INSERT INTO playlist_video (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)'
      ).run(playlistId, videoIds.get(code), position, now)
    }
  })()
}
