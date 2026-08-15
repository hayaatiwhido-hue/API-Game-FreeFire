# Stats Engine V2

## O que foi corrigido

A V1 fazia a operação de pesquisa de forma bloqueante e depois recarregava a página a cada segundo. Isso não é adequado para uma aplicação JavaScript como o MatchStats.

A V2 muda a arquitetura:

1. Abre o MatchStats com Chromium/Playwright.
2. Espera a aplicação JavaScript carregar.
3. Localiza a área de Match e o campo real de MatchID.
4. Pesquisa o MatchID.
5. Mantém a mesma página aberta.
6. Captura o DOM visível a cada 1 segundo.
7. Compara os dados capturados e contabiliza alterações.
8. Não usa dados fictícios.
9. A API `/api/start` responde imediatamente; a inicialização do navegador continua em segundo plano, evitando que a interface fique presa esperando o processo terminar.
10. Inclui diagnóstico da fase atual, URL, título, campo encontrado e pesquisa acionada.

## Arquivos

Todos ficam diretamente na raiz do repositório:

- index.html
- server.js
- package.json
- Dockerfile
- render.yaml
- .dockerignore
- README.md

## Deploy no Render

Use:
- Runtime: Docker
- Root Directory: vazio
- Instance: Free para o primeiro teste

Depois do deploy, abra a URL do serviço e use o MatchID real.

## Importante sobre o teste

O painel agora diferencia:

- INICIANDO
- PESQUISANDO
- CONECTADO
- ERRO

Se ocorrer erro, o bloco DIAGNÓSTICO mostra em qual etapa ocorreu.

O endpoint `/health` confirma que o servidor está vivo.

## Fonte

O projeto aponta por padrão para:

https://matchstats.us.ffesports.com/

A página do MatchStats é uma aplicação JavaScript e exibe uma interface de consulta de partidas. A captura nesta versão é feita pelo navegador automatizado, não por dados fictícios.

## Próxima etapa

Só depois de confirmar que o MatchID real está sendo encontrado e que o DOM contém os dados verdadeiros, devemos criar o parser estruturado para equipes, jogadores, kills, posição, pontos e demais informações.
