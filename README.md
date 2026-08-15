# Stats Engine v1.2

## Estrutura para envio pelo celular

Todos os arquivos importantes estão diretamente na raiz:

- index.html
- server.js
- package.json
- Dockerfile
- render.yaml
- .dockerignore
- README.md

Não existe pasta `public`.

## Objetivo

Validar somente:

MatchID real → MatchStats oficial → navegador Playwright → captura real → painel → atualização de 1 segundo.

Nenhum dado fictício é incluído.

## Render

O projeto usa Docker porque o Playwright precisa do navegador Chromium.

No Render:
1. Crie um Web Service.
2. Conecte o GitHub.
3. Selecione o repositório.
4. Runtime/Language: Docker.
5. Dockerfile: `./Dockerfile`.
6. O `CMD` do Dockerfile inicia o servidor.

O `render.yaml` também pode ser usado como Blueprint.

## GitHub pelo celular

Como o `index.html` está na raiz, você pode criar/enviar cada arquivo diretamente na raiz do repositório, sem precisar enviar a pasta `public`.

## Atualização do código

Com o repositório conectado ao Render, novos commits na branch configurada podem disparar novos deploys.

## Teste

Abra a URL do serviço, coloque um MatchID real e clique em INICIAR.

O painel mostra o snapshot bruto que o navegador automatizado capturou do MatchStats.

Se aparecer erro de campo, navegação ou carregamento, o erro deve ser corrigido antes de transformar os dados em leaderboard, jogadores, kills etc.
