// Perft reference counts: standard positions from the Chess Programming Wiki, Chess960
// positions counted by the native engine (bin/darkhelmet, itself checked with tools/perft960.py).
export const PERFT_CASES = [
  {
    "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "chess960": false,
    "depth": 5,
    "nodes": 4865609
  },
  {
    "fen": "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "chess960": false,
    "depth": 4,
    "nodes": 4085603
  },
  {
    "fen": "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "chess960": false,
    "depth": 6,
    "nodes": 11030083
  },
  {
    "fen": "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    "chess960": false,
    "depth": 5,
    "nodes": 15833292
  },
  {
    "fen": "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "chess960": false,
    "depth": 4,
    "nodes": 2103487
  },
  {
    "fen": "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    "chess960": false,
    "depth": 4,
    "nodes": 3894594
  },
  {
    "fen": "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 201143
  },
  {
    "fen": "bbnnrkrq/pppppppp/8/8/8/8/PPPPPPPP/BBNNRKRQ w GEge - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 234097
  },
  {
    "fen": "bbnrnkqr/pppppppp/8/8/8/8/PPPPPPPP/BBNRNKQR w HDhd - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 200232
  },
  {
    "fen": "bbnrkqnr/pppppppp/8/8/8/8/PPPPPPPP/BBNRKQNR w HDhd - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 201307
  },
  {
    "fen": "bbnrqkrn/pppppppp/8/8/8/8/PPPPPPPP/BBNRQKRN w GDgd - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 197033
  },
  {
    "fen": "bbrqnnkr/pppppppp/8/8/8/8/PPPPPPPP/BBRQNNKR w HChc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 202125
  },
  {
    "fen": "bbqrnknr/pppppppp/8/8/8/8/PPPPPPPP/BBQRNKNR w HDhd - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 201336
  },
  {
    "fen": "bbrnknrq/pppppppp/8/8/8/8/PPPPPPPP/BBRNKNRQ w GCgc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 204795
  },
  {
    "fen": "bbrnkrqn/pppppppp/8/8/8/8/PPPPPPPP/BBRNKRQN w FCfc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 169283
  },
  {
    "fen": "bbrknqnr/pppppppp/8/8/8/8/PPPPPPPP/BBRKNQNR w HChc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 237948
  },
  {
    "fen": "bbrkqnrn/pppppppp/8/8/8/8/PPPPPPPP/BBRKQNRN w GCgc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 197708
  },
  {
    "fen": "bbrqkrnn/pppppppp/8/8/8/8/PPPPPPPP/BBRQKRNN w FCfc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 163633
  },
  {
    "fen": "1rqbkrbn/1ppppp1p/1n6/p1N3p1/8/2P4P/PP1PPPP1/1RQBKRBN w FBfb - 0 9",
    "chess960": true,
    "depth": 4,
    "nodes": 287739
  },
  {
    "fen": "rbbqn1kr/pp2p1pp/6n1/2pp1p2/2P4P/P7/BP1PPPP1/R1BQNNKR w HAha - 0 9",
    "chess960": true,
    "depth": 4,
    "nodes": 890435
  },
  {
    "fen": "2r1kr2/8/8/8/8/8/8/1R2K1R1 w GBfc - 0 1",
    "chess960": true,
    "depth": 4,
    "nodes": 264663
  }
];
