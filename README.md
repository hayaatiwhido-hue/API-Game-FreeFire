# FFWS vMix MultiMatch Server 2.0

Servidor completo para capturar várias quedas pelo MatchID no MatchStats e distribuir dados para overlays HTML transparentes do vMix.

## O que foi incluído

- Vários MatchIDs ao mesmo tempo.
- Seleção de uma queda específica.
- Modo `TODAS AS QUEDAS`, somando as quedas adicionadas.
- Team Data e Player Data mantendo a ordem dos campos configurados.
- Correção do problema de deslocamento de coluna: o valor é associado pela posição real da célula da tabela, sem transformar Team Name em cabeçalho/linha anterior.
- Observação DOM + ciclo de verificação configurado em 1 ms por padrão.
- SSE para entregar mudanças aos overlays sem esperar o próximo ciclo visual.
- Ranking da Queda persistente enquanto ativado.
- TOPs individuais com entrada automática quando o líder/valor muda.
- Ativar/desativar individualmente todas as overlays.
- Botão TESTAR para qualquer overlay.
- PNGs base prontos para substituir.
- Modo de arte `complete` ou possibilidade de trocar para assets separados no `overlay-config.js`.
- Arquivo separado para posições, campos extras, campeonato, sponsor, logos e fotos.

## Overlays

### Equipes
1. Ranking da Queda
2. Equipe com mais Abates (KillerLeader / Kill)
3. Top Dano (Damage)
4. Headshots
5. Top Assist. (Assist)
6. Top Revival (Revival)
7. Equipe Eliminada

### Jogadores
1. Player com mais Eliminações
2. Player com maior Dano
3. Player com mais Assistências
4. Player que mais andou no Mapa
5. Player com mais Headshots
6. Player que mais foi derrubado
7. Mais reviveu aliados
8. Abate mais distante

## Abrir

`/control.html`

## vMix

Use as URLs exibidas no próprio painel. Todas as overlays são HTML transparente e podem ser usadas como Browser Input.

## Personalização

- `overlay-config.js`: posições, tamanho, animações, duração, textos e campos extras.
- `overlay-data.js`: logos por Team ID/Team Name e fotos por Player ID/UID/Nickname.
- `*.png`: artes completas baseadas no estilo das referências enviadas. Podem ser substituídas sem alterar o código.
- ``: peças para montar uma overlay por assets.

## Execução local

```bash
npm install
npx playwright install chromium
npm start
```

Depois abra `/control.html`.

## Render

O `Dockerfile` já instala Chromium para Playwright. O `render.yaml` usa `POLL_MS=1`.

## Observação importante sobre 1 ms

O servidor deixa o ciclo configurado em 1 ms, mas uma requisição HTTP/um navegador não consegue garantir fisicamente uma nova ida ao site oficial a cada 1 ms. Por isso o sistema usa MutationObserver + SSE: quando o MatchStats muda o DOM, a captura é disparada rapidamente e os overlays recebem o evento imediatamente.
