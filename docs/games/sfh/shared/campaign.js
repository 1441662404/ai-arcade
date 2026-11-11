/**
 * 战役关卡 —— 复刻原作「单人/合作推进剧情关卡」的骨架。
 *
 * 每个关卡定义一个目标 + 若干波次敌人。玩家（蓝队）为进攻方，
 * 敌方由服务端按波次生成。世界只负责推进波次状态机，
 * 真正的「加人」交给服务端（World.pendingSpawns 队列）。
 *
 * objective:
 *   eliminate  消灭指定数量的敌人
 *   survive    在限定时间内守住阵地（全员不死超过上限）
 *   capture    占领并保持全部据点若干秒
 */

export const CAMPAIGN = [
  {
    id: 'c1',
    name: '第一关 · 登陆日',
    mapId: 'labs',
    objective: 'eliminate',
    brief: '运输机把你投在了废弃实验区。清空这片区域，建立前哨。',
    target: 10,
    maxDeaths: 12,
    difficulty: 2,
    reward: 80,
    waves: [
      { n: 4, delay: 1.5 },
      { n: 4, delay: 2.0 },
      { n: 4, delay: 2.0 },
    ],
  },
  {
    id: 'c2',
    name: '第二关 · 丛林遭遇',
    mapId: 'jungle',
    objective: 'eliminate',
    brief: '丛林里有埋伏。掩护小队穿过林线，别让他们绕到侧翼。',
    target: 16,
    maxDeaths: 12,
    difficulty: 3,
    reward: 120,
    waves: [
      { n: 5, delay: 1.5 },
      { n: 5, delay: 2.0 },
      { n: 6, delay: 2.5 },
    ],
  },
  {
    id: 'c3',
    name: '第三关 · 残骸防线',
    mapId: 'wreck',
    objective: 'survive',
    brief: '飞机撑不了多久了。在他们冲垮防线之前守住 75 秒。',
    target: 75,           // 存活秒数
    maxDeaths: 16,
    difficulty: 3,
    reward: 150,
    waves: [
      { n: 4, delay: 2.0 },
      { n: 5, delay: 3.0 },
      { n: 6, delay: 3.0 },
      { n: 6, delay: 3.0 },
    ],
  },
  {
    id: 'c4',
    name: '第四关 · 据点夺还',
    mapId: 'labs',
    objective: 'capture',
    brief: '夺回我方前沿补给据点，然后顶住反扑、守住 30 秒。',
    target: 30,             // 达标后需保持的秒数
    capturePoints: ['A'],   // 我方前沿据点（主场防守）
    maxDeaths: 20,
    difficulty: 3,
    reward: 180,
    waves: [
      { n: 4, delay: 1.5 },
      { n: 4, delay: 2.5 },
      { n: 5, delay: 2.5 },
    ],
  },
  {
    id: 'c5',
    name: '第五关 · 精锐反扑',
    mapId: 'jungle',
    objective: 'eliminate',
    brief: '对方的精锐下场了。这一波全是硬点子，撑住。',
    target: 22,
    maxDeaths: 14,
    difficulty: 5,
    reward: 240,
    waves: [
      { n: 6, delay: 1.5 },
      { n: 7, delay: 2.0 },
      { n: 7, delay: 2.0 },
    ],
  },
  {
    id: 'c6',
    name: '第六关 · 最后防线',
    mapId: 'wreck',
    objective: 'survive',
    brief: '援军还有 100 秒到。你只需要做一件事：活下来。',
    target: 100,
    maxDeaths: 24,
    difficulty: 5,
    reward: 320,
    waves: [
      { n: 5, delay: 1.5 },
      { n: 6, delay: 2.5 },
      { n: 6, delay: 2.5 },
      { n: 7, delay: 2.5 },
      { n: 7, delay: 3.0 },
    ],
  },
];

export const CAMPAIGN_LIST = CAMPAIGN.map(c => c.id);

export function getLevel(id) {
  return CAMPAIGN.find(c => c.id === id) || CAMPAIGN[0];
}

/** 第几关（从 1 开始） */
export function levelIndex(id) {
  const i = CAMPAIGN.findIndex(c => c.id === id);
  return i < 0 ? 1 : i + 1;
}
