# FFWS Stats Engine · Multi Match + vMix

Sistema para adicionar vários MatchIDs do MatchStats, acompanhar as quedas em tempo real e alimentar overlays para vMix.

## O que foi adicionado

- Vários MatchIDs ao mesmo tempo.
- Seleção de **UMA QUEDA** ou **TODAS AS QUEDAS**.
- No modo **TODAS AS QUEDAS**, Team Data e Player Data são somados por equipe/jogador.
- Atualização do servidor programada em **1 ms**, com proteção para não executar duas leituras simultaneamente no mesmo MatchID.
- Cabeçalhos Team Data e Player Data mantidos na ordem canônica e com correção do desalinhamento entre cabeçalho e dados.
- Ranking da Queda: liga/desliga e fica persistente enquanto ativado.
- TOPs: entram automaticamente quando o líder/valor muda.
- Botão TESTAR para cada overlay.
- Preview ao vivo dentro da interface principal.
- Overlays para equipe e jogador, com animação de entrada/saída.
- `overlay-config.js` para posição, campeonato, sponsor, texto extra e configurações visuais.
- PNGs 1920×1080 prontos para substituir, todos na raiz do projeto.
- `overlay-data.js` para mapear logos de equipes e fotos de jogadores.

## Overlays

### Equipes
- `teamKills` — Equipe com mais Abates
- `teamDamage` — Top Dano
- `teamHeadshots` — Headshots
- `teamAssist` — Top Assist.
- `teamRevival` — Top Revival
- `teamEliminated` — Equipe Eliminada, somente quando houver estado explícito de eliminado/morto nos dados disponíveis
- `ranking` — Ranking da Queda

### Jogadores
- `playerKills`
- `playerDamage`
- `playerAssist`
- `playerMovingDistance`
- `playerHeadshots`
- `playerKnockDown`
- `playerRescueMembers`
- `playerMaximumKillDistance`

## URLs para vMix

- `/overlay-ranking.html`
- `/overlay-team-top.html?key=teamKills`
- `/overlay-team-top.html?key=teamDamage`
- `/overlay-team-top.html?key=teamHeadshots`
- `/overlay-team-top.html?key=teamAssist`
- `/overlay-team-top.html?key=teamRevival`
- `/overlay-eliminated.html`
- `/overlay-player-top.html?key=playerKills`
- `/overlay-player-top.html?key=playerDamage`
- `/overlay-player-top.html?key=playerAssist`
- `/overlay-player-top.html?key=playerMovingDistance`
- `/overlay-player-top.html?key=playerHeadshots`
- `/overlay-player-top.html?key=playerKnockDown`
- `/overlay-player-top.html?key=playerRescueMembers`
- `/overlay-player-top.html?key=playerMaximumKillDistance`

## Configuração das artes

Edite apenas `overlay-config.js` para alterar posições e textos. Os PNGs podem ser substituídos mantendo os mesmos nomes.

Edite `overlay-data.js` para associar:
- Team ID/Team Name → logo
- Player ID/UID/Player Name → foto

Tudo foi mantido na raiz principal para facilitar o upload pelo GitHub no celular.
