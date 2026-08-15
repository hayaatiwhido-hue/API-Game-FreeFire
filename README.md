# Stats Engine 2.1.1

- Interface refeita em cinza/vermelho.
- Team Data e Player Data com cabeçalho separado dos registros.
- Parser reforçado para nunca transformar uma linha com valores numéricos em cabeçalho; Top 1 e Top 2 permanecem em linhas separadas.
- Verificação automática no servidor em intervalo de 10 ms, com proteção contra recargas simultâneas.
- Exportação de Team Data, Player Data e dados completos em CSV, usando os mesmos cabeçalhos exibidos na interface.
- Playwright 1.62.1.
