# Stats Engine 1.0.2

Arquivos propositalmente na RAIZ do projeto para facilitar upload pelo GitHub no celular.

## O que esta versão corrige

- Playwright alinhado com a imagem Docker `v1.62.1-noble`, evitando o erro da 1.0.1:
  `Executable doesn't exist ... chrome-headless-shell-1234`
- MatchID é enviado ao servidor.
- O servidor abre o MatchStats oficial.
- Pesquisa o MatchID.
- Entra automaticamente em `View`.
- Captura as tabelas visíveis.
- Classifica tabelas de TeamData e PlayerData.
- Tenta acessar Player Data quando ele estiver em uma aba/controle separado.
- Interface permite baixar todos os dados capturados em JSON.

## Deploy no Render

Use **Docker** como Runtime/Environment e deixe o Render construir a imagem pelo `Dockerfile`.

Arquivos na raiz:
- `Dockerfile`
- `package.json`
- `server.js`
- `index.html`

Não mova os arquivos para uma pasta.

## Observação

O MatchStats pode alterar HTML, seletores ou a forma como PlayerData é aberto. A captura foi feita de forma tolerante, procurando texto, atributos e tabelas em vez de depender de um único seletor.
