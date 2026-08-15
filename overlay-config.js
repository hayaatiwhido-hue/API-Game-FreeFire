window.OVERLAY_CONFIG = {
  canvas: { width: 1920, height: 1080 },
  apiBase: '',
  animation: { enterMs: 420, exitMs: 360, topDurationMs: 6500 },
  theme: {
    accent: '#FFC400',
    accent2: '#FF9D00',
    dark: '#111315',
    white: '#FFFFFF',
    muted: '#A9ADB4',
    success: '#21D36B',
    danger: '#F32738'
  },
  fields: {
    // Você pode adicionar campos extras por campeonato sem mexer no servidor.
    championship: 'FFWS Brasil',
    split: 'Split 2',
    season: '2026',
    sponsor: '',
    extraText: ''
  },
  positions: {
    team: { logo:{x:960,y:445,w:300,h:300}, name:{x:960,y:790}, value:{x:960,y:900} },
    player: { photo:{x:280,y:540,w:310,h:350}, logo:{x:960,y:450,w:310,h:310}, name:{x:960,y:765}, team:{x:960,y:805}, value:{x:960,y:885} },
    eliminated: { logo:{x:285,y:530,w:280,h:280}, rank:{x:865,y:835,w:180}, name:{x:1360,y:835,w:760} },
    extraText: { x:960, y:980, w:1500 },
    ranking: { x:650, y:182, w:1020, rowH:72, logoX:820, teamX:955, valueX:1400, rankX:735, statusX:1520 }
  },
  overlays: {
    ranking: { mode:'complete', background:'ranking.png' },
    teamKills: { mode:'complete', background:'team-kills.png', title:'ELIMS' },
    teamDamage: { mode:'complete', background:'team-damage.png', title:'DAMAGE' },
    teamHeadshots: { mode:'complete', background:'team-headshots.png', title:'HEADSHOTS' },
    teamAssist: { mode:'complete', background:'team-assist.png', title:'ASSIST' },
    teamRevival: { mode:'complete', background:'team-revival.png', title:'REVIVAL' },
    teamEliminated: { mode:'complete', background:'team-eliminated.png', title:'ELIMINADO' },
    playerKills: { mode:'complete', background:'player-kills.png', title:'ELIMS' },
    playerDamage: { mode:'complete', background:'player-damage.png', title:'DAMAGE' },
    playerAssist: { mode:'complete', background:'player-assist.png', title:'ASSIST' },
    playerMovingDistance: { mode:'complete', background:'player-moving-distance.png', title:'DISTÂNCIA' },
    playerHeadshots: { mode:'complete', background:'player-headshots.png', title:'HEADSHOTS' },
    playerKnockDown: { mode:'complete', background:'player-knockdown.png', title:'KNOCKS' },
    playerRescueMembers: { mode:'complete', background:'player-rescue-members.png', title:'RESCUE' },
    playerMaximumKillDistance: { mode:'complete', background:'player-maximum-kill-distance.png', title:'DISTÂNCIA DO ABATE' }
  }
};
