# Stats Engine 2.2.0

Leitor de Team Data e Player Data do MatchStats com cadastro local de jogadores.

## Cadastro de jogadores

Na interface existe uma seção **Cadastro de jogadores**. Cadastre:

- **ID do jogador**: o Player ID/UID que aparece no MatchStats.
- **Nick registrado**: o nome que você quer que apareça no sistema.

Exemplo:

`431899074` → `Jota99z!`

Quando o MatchStats retornar `431899074` com o Nick `RSE.italo7`, a interface passa a mostrar `Jota99z!` no Player Data e no seletor de jogadores.

O cadastro é salvo em `players.json`. Se o mesmo ID for cadastrado novamente, o Nick é atualizado. Também é possível excluir registros pela própria interface.

## Execução

```bash
npm install
npm start
```

A aplicação usa Node.js 20+, Express 5 e Playwright 1.62.1.
