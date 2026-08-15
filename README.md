# Stats Engine v1.1 — teste de captura real

## Objetivo

Primeira versão para validar somente o fluxo:

MatchID → MatchStats oficial → navegador automatizado → dados reais → painel.

Não há dados genéricos ou fictícios no projeto.

## Hospedagem

A estrutura já contém `Dockerfile` e `render.yaml` para Render. O Render suporta Docker e pode reconstruir/reimplantar o serviço quando houver novos commits no repositório conectado. 

O plano gratuito é apropriado para teste, mas possui limitações; o Render informa que serviços web gratuitos podem entrar em suspensão após 15 minutos sem atividade. 

## Deploy pelo GitHub

1. Crie um repositório no GitHub.
2. Envie todos os arquivos deste ZIP para a raiz do repositório.
3. No Render, escolha `New > Web Service`.
4. Conecte o repositório.
5. Selecione o runtime `Docker`.
6. Use o plano Free para o primeiro teste.
7. Faça o deploy.

O `render.yaml` já deixa a URL do MatchStats configurada.

## Teste

Abra a URL fornecida pelo Render e coloque um MatchID real.

O painel mostra:
- status da conexão;
- quantidade de consultas;
- quantidade de alterações detectadas;
- horário da última atualização;
- snapshot bruto realmente capturado pelo navegador.

## Atualização

Depois do primeiro deploy, alterações no repositório conectado podem disparar novo deploy automaticamente.

## Importante

Esta fase deliberadamente não transforma o conteúdo em leaderboard ou cards. Primeiro valide que o MatchID real aparece no snapshot e que as alterações do MatchStats chegam ao painel. Depois disso, a camada de interpretação dos dados pode ser construída em cima da captura validada.
