/**
 * 共享常量 —— 服务端与客户端必须使用完全相同的数值，
 * 否则客户端预测会与服务端权威结果持续打架。
 */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const SNAP_RATE = 20;                  // 快照下发频率
export const SNAP_INTERVAL = 1 / SNAP_RATE;

export const PHYS = {
  GRAVITY: 2400,
  MAX_FALL: 1500,

  GROUND_ACCEL: 4200,
  AIR_ACCEL: 2200,
  GROUND_FRICTION: 5200,
  AIR_FRICTION: 500,
  MOVE_MAX: 300,

  JUMP_V: -790,
  COYOTE_TIME: 0.1,
  JUMP_BUFFER: 0.12,

  // 跳跃高度随按住时间变化
  JUMP_CUT: 0.45,

  W: 26,
  H: 46,
  CROUCH_H: 30,

  // 被击退
  KNOCKBACK: 90,
  HEADSHOT_MUL: 1.75,
};

export const COMBAT = {
  RESPAWN_TIME: 3.0,
  SPAWN_PROTECT: 2.0,
  HEALTH_PICKUP: 45,
  AMMO_PICKUP: 0.5,       // 补满备弹的比例
  PICKUP_RESPAWN: 12,
  MEDIC_HEAL_RATE: 16,    // 医疗兵被动：每秒回血
  MEDIC_HEAL_RADIUS: 150,
  MEDIC_HEAL_SHARE: 8,
  SKILL_CHARGE_KILLS: 5,
  MAX_TEAM_SIZE: 6,
};

/** 队伍 */
export const TEAMS = {
  blue: { id: 'blue', name: '蓝队', color: '#3fa9ff', color2: '#0b4b82', dark: '#0a2540' },
  red:  { id: 'red',  name: '红队', color: '#ff5a52', color2: '#8c1d1a', dark: '#3d0f0d' },
};

/** 四大兵种 —— 复刻原作：医疗兵 / 狙击手 / 突击兵 / 坦克兵 */
export const CLASSES = {
  assault: {
    id: 'assault',
    name: '突击兵',
    en: 'Assault',
    desc: '火力凶猛，正面压制力无敌。步枪扫射与火箭筒清场，冲就完了。',
    hp: 130,
    speedMul: 1.0,
    jumpMul: 1.0,
    accent: '#ff8a3d',
    loadout: ['rifle', 'rpg'],
    secondary: 'pistol',
    skill: {
      id: 'adrenaline',
      name: '狂暴射击',
      desc: '6 秒内射速翻倍、后坐力归零、伤害提升 25%',
      dur: 6,
      need: COMBAT.SKILL_CHARGE_KILLS,
    },
  },
  sniper: {
    id: 'sniper',
    name: '狙击手',
    en: 'Sniper',
    desc: '精准度拉满，千里之外取敌首级。脆弱但致命，站桩就是死。',
    hp: 90,
    speedMul: 1.05,
    jumpMul: 1.08,
    accent: '#7ee787',
    loadout: ['sniper', 'smg'],
    secondary: 'pistol',
    skill: {
      id: 'cloak',
      name: '幽灵隐身',
      desc: '5 秒隐身并大幅提速，出手瞬间显形',
      dur: 5,
      need: COMBAT.SKILL_CHARGE_KILLS,
    },
  },
  medic: {
    id: 'medic',
    name: '医疗兵',
    en: 'Medic',
    desc: '团队回血核心，中距离火力稳定。拉扯作战、救死扶伤全靠他。',
    hp: 115,
    speedMul: 1.0,
    jumpMul: 1.0,
    accent: '#6ee7f9',
    loadout: ['mg', 'smg'],
    secondary: 'pistol',
    skill: {
      id: 'nano',
      name: '纳米治疗场',
      desc: '立刻回满自身血量，并在 8 秒内持续治疗附近队友',
      dur: 8,
      need: COMBAT.SKILL_CHARGE_KILLS,
    },
  },
  tank: {
    id: 'tank',
    name: '坦克兵',
    en: 'Tank',
    desc: '身板厚实，近战喷子配盾牌。冲脸硬刚毫无惧色。',
    hp: 200,
    speedMul: 0.86,
    jumpMul: 0.92,
    accent: '#c084fc',
    loadout: ['shotgun', 'shield'],
    secondary: 'pistol',
    skill: {
      id: 'ironskin',
      name: '钢铁之躯',
      desc: '7 秒内受到伤害减少 70%，免疫击退',
      dur: 7,
      need: COMBAT.SKILL_CHARGE_KILLS,
    },
  },
  assassin: {
    id: 'assassin',
    name: '刺客',
    en: 'Assassin',
    desc: '玻璃大炮。血量最薄、跑得最快，一刀一个，代价是必须贴到脸上。',
    hp: 80,
    speedMul: 1.22,
    jumpMul: 1.15,
    accent: '#f472b6',
    loadout: ['katana', 'smg'],
    secondary: 'magnum',
    skill: {
      id: 'dash',
      name: '瞬步突袭',
      desc: '向瞄准方向瞬移一段距离，期间免疫伤害，落地即出刀',
      dur: 0.35,
      need: 3,
    },
  },
  ninja: {
    id: 'ninja',
    name: '忍者',
    en: 'Ninja',
    desc: '投掷手里剑远程骚扰，烟雾弹脱战。攻守转换最灵活的多面手。',
    hp: 100,
    speedMul: 1.12,
    jumpMul: 1.12,
    accent: '#5eead4',
    loadout: ['shuriken', 'smg'],
    secondary: 'burst',
    skill: {
      id: 'smoke',
      name: '烟遁',
      desc: '原地爆开烟雾：短暂隐身、加速，并致盲附近敌人的瞄准',
      dur: 4.5,
      need: 4,
    },
  },
};

/** 兵种解锁等级（progression.js 读取；0 = 初始可用） */
export const CLASS_UNLOCK = {
  assault: 0, sniper: 0, medic: 0, tank: 0,
  assassin: 3, ninja: 5,
};

export const CLASS_LIST = ['assault', 'sniper', 'medic', 'tank', 'assassin', 'ninja'];

/** 按键位掩码（网络传输用） */
export const KEY = {
  LEFT: 1,
  RIGHT: 2,
  UP: 4,
  DOWN: 8,
  SHOOT: 16,
  RELOAD: 32,
  SWITCH: 64,
  SKILL: 128,
};

/** 游戏模式 */
export const MODES = {
  tdm: {
    id: 'tdm',
    name: '团队死斗',
    en: 'Team Deathmatch',
    desc: '蓝队与红队正面刚枪，先达到击杀目标的队伍获胜。',
    scoreLimit: 50,
    timeLimit: 8 * 60,
  },
  ffa: {
    id: 'ffa',
    name: '个人竞技',
    en: 'Free For All',
    desc: '全员混战，没有队友。率先达到击杀数的个人获胜。',
    scoreLimit: 30,
    timeLimit: 8 * 60,
  },
  dom: {
    id: 'dom',
    name: '据点争夺',
    en: 'Domination',
    desc: '抢占三处据点，控制据点持续得分，先到分数上限者胜。',
    scoreLimit: 200,
    timeLimit: 8 * 60,
  },
};

export const MODE_LIST = ['tdm', 'ffa', 'dom'];

export const MAX_PLAYERS = 12;   // 12 人房（6v6），人不够由 AI 补位
export const MAX_HUMANS = 5;     // 一台设备最多组队的真人队友

/** 调色 */
export const SKY = {
  top: '#0b1220',
  mid: '#16263d',
  bot: '#24405c',
};
