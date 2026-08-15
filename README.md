# Stats Engine V3

Esta versão muda a arquitetura do teste anterior:

1. O servidor pesquisa `https://matchstats.us.ffesports.com/match?search=MATCH_ID`.
2. Ele procura o resultado correspondente e tenta localizar a operação/link `View`.
3. Abre a página específica da partida.
4. Extrai somente dados estruturados da página específica: título, headings, metadados e tabelas HTML.
5. O frontend recebe as alterações por Server-Sent Events (SSE), sem recarregar a página.
6. O monitor consulta novamente a cada 1 segundo.

Importante: esta versão não cria jogadores, equipes ou números fictícios. Se o MatchStats mudar o HTML ou exigir uma etapa diferente para abrir `View`, o resultado indicará isso em vez de inventar dados.

## Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: deixe vazio
- Branch: `main`

O serviço precisa ser criado como Web Service, porque o scraper roda no servidor. Render exige que o servidor escute em `0.0.0.0` e permite deploy automático a partir do GitHub.

## Estrutura

- `index.html` fica na raiz de `public/`, mas o arquivo do site é servido pela raiz pública do serviço.
- `server.js`
- `package.json`
- `public/index.html`

## Testes

Depois do deploy:
- abra o endereço do Render;
- coloque o Match ID;
- toque em INICIAR;
- aguarde a primeira consulta;
- confira se aparece a página específica da partida e suas tabelas.

Endpoints úteis:
- `/api/health`
- `/api/state`
- `/api/match/1`
