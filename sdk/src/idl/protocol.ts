/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/protocol.json`.
 */
export type Protocol = {
  "address": "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy",
  "metadata": {
    "name": "protocol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Solana program built with Anchor"
  },
  "instructions": [
    {
      "name": "adminWithdrawInventory",
      "docs": [
        "docs/SPECIFICATION.md §3.6"
      ],
      "discriminator": [
        10,
        147,
        47,
        189,
        145,
        123,
        7,
        164
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "poolState"
          ]
        },
        {
          "name": "poolState"
        },
        {
          "name": "baseVault",
          "writable": true,
          "relations": [
            "poolState"
          ]
        },
        {
          "name": "quoteVault",
          "writable": true,
          "relations": [
            "poolState"
          ]
        },
        {
          "name": "adminBaseAta",
          "writable": true
        },
        {
          "name": "adminQuoteAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "withdrawBaseAmount",
          "type": "u64"
        },
        {
          "name": "withdrawQuoteAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeExpiredNonce",
      "docs": [
        "docs/SPECIFICATION.md §3.7"
      ],
      "discriminator": [
        158,
        49,
        31,
        71,
        132,
        92,
        88,
        159
      ],
      "accounts": [
        {
          "name": "closer",
          "writable": true,
          "signer": true
        },
        {
          "name": "poolState"
        },
        {
          "name": "quoteNonceMarker",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "executeSwap",
      "docs": [
        "docs/SPECIFICATION.md §3.3 — Curve/RFQ hybrid swap (ExactIn)"
      ],
      "discriminator": [
        56,
        182,
        124,
        215,
        155,
        140,
        157,
        102
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "poolState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "pool_state.base_mint",
                "account": "poolState"
              },
              {
                "kind": "account",
                "path": "pool_state.quote_mint",
                "account": "poolState"
              }
            ]
          }
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "userBaseAta",
          "writable": true
        },
        {
          "name": "userQuoteAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "inputAmount",
          "type": "u64"
        },
        {
          "name": "direction",
          "type": {
            "defined": {
              "name": "side"
            }
          }
        },
        {
          "name": "minOutput",
          "type": "u64"
        },
        {
          "name": "signedQuoteOpt",
          "type": {
            "option": {
              "defined": {
                "name": "signedQuote"
              }
            }
          }
        }
      ]
    },
    {
      "name": "initPool",
      "docs": [
        "docs/SPECIFICATION.md §3.1"
      ],
      "discriminator": [
        116,
        233,
        199,
        204,
        115,
        159,
        171,
        36
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "poolState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "quoteMint"
        },
        {
          "name": "baseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "poolState"
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "quoteVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "poolState"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "authorizedOracleSigner",
          "type": "pubkey"
        },
        {
          "name": "initialFairValue",
          "type": "u64"
        },
        {
          "name": "initialSpreadBps",
          "type": "u16"
        },
        {
          "name": "initialDepthParams",
          "type": {
            "defined": {
              "name": "depthParams"
            }
          }
        },
        {
          "name": "initialSkewParams",
          "type": {
            "defined": {
              "name": "skewParams"
            }
          }
        },
        {
          "name": "initialModeTtl",
          "type": "u8"
        }
      ]
    },
    {
      "name": "rotateAdmin",
      "docs": [
        "docs/SPECIFICATION.md §3.7"
      ],
      "discriminator": [
        123,
        96,
        122,
        175,
        190,
        137,
        229,
        207
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "poolState"
          ]
        },
        {
          "name": "poolState",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "rotateOracleSigner",
      "docs": [
        "docs/SPECIFICATION.md §3.5"
      ],
      "discriminator": [
        93,
        64,
        240,
        241,
        167,
        239,
        158,
        168
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "poolState"
          ]
        },
        {
          "name": "poolState",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newAuthorizedOracleSigner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "docs/SPECIFICATION.md §3.4"
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "poolState"
          ]
        },
        {
          "name": "poolState",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "updateOracle",
      "docs": [
        "docs/SPECIFICATION.md §3.2"
      ],
      "discriminator": [
        112,
        41,
        209,
        18,
        248,
        226,
        252,
        188
      ],
      "accounts": [
        {
          "name": "oracleSigner",
          "signer": true
        },
        {
          "name": "poolState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "pool_state.base_mint",
                "account": "poolState"
              },
              {
                "kind": "account",
                "path": "pool_state.quote_mint",
                "account": "poolState"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newFairValue",
          "type": "u64"
        },
        {
          "name": "newSpreadBps",
          "type": "u16"
        },
        {
          "name": "newDepthParams",
          "type": {
            "defined": {
              "name": "depthParams"
            }
          }
        },
        {
          "name": "newSkewParams",
          "type": {
            "defined": {
              "name": "skewParams"
            }
          }
        },
        {
          "name": "newNonce",
          "type": "u64"
        },
        {
          "name": "newTtl",
          "type": "u8"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "poolState",
      "discriminator": [
        247,
        237,
        227,
        245,
        215,
        195,
        222,
        70
      ]
    },
    {
      "name": "quoteNonceMarker",
      "discriminator": [
        249,
        181,
        84,
        142,
        255,
        202,
        226,
        158
      ]
    }
  ],
  "events": [
    {
      "name": "adminRotated",
      "discriminator": [
        21,
        142,
        227,
        252,
        22,
        194,
        172,
        220
      ]
    },
    {
      "name": "inventoryWithdrawn",
      "discriminator": [
        56,
        87,
        241,
        167,
        133,
        12,
        5,
        149
      ]
    },
    {
      "name": "oracleSignerRotated",
      "discriminator": [
        218,
        14,
        251,
        249,
        174,
        10,
        155,
        93
      ]
    },
    {
      "name": "oracleUpdated",
      "discriminator": [
        138,
        9,
        51,
        219,
        228,
        198,
        11,
        147
      ]
    },
    {
      "name": "poolInitialized",
      "discriminator": [
        100,
        118,
        173,
        87,
        12,
        198,
        254,
        229
      ]
    },
    {
      "name": "poolPausedChanged",
      "discriminator": [
        236,
        188,
        74,
        210,
        192,
        77,
        234,
        216
      ]
    },
    {
      "name": "quoteMarkerClosed",
      "discriminator": [
        30,
        20,
        204,
        4,
        159,
        193,
        43,
        246
      ]
    },
    {
      "name": "swapExecuted",
      "discriminator": [
        150,
        166,
        26,
        225,
        28,
        89,
        38,
        79
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow occurred."
    },
    {
      "code": 6001,
      "name": "mathError",
      "msg": "Math error occurred (division by zero or invalid operation)."
    },
    {
      "code": 6002,
      "name": "mathUnderflow",
      "msg": "Arithmetic underflow occurred."
    },
    {
      "code": 12100,
      "name": "invalidMintPair",
      "msg": "base_mint and quote_mint must be different."
    },
    {
      "code": 12101,
      "name": "mintsNotSorted",
      "msg": "Mints must be lexicographically sorted (base_mint < quote_mint)."
    },
    {
      "code": 12102,
      "name": "invalidTtl",
      "msg": "TTL out of allowed range."
    },
    {
      "code": 12103,
      "name": "invalidFairValue",
      "msg": "fair_value must be greater than zero."
    },
    {
      "code": 12104,
      "name": "invalidSpread",
      "msg": "spread_bps exceeds MAX_SPREAD_BPS."
    },
    {
      "code": 12105,
      "name": "invalidSize",
      "msg": "input_amount must be greater than zero."
    },
    {
      "code": 12106,
      "name": "invalidDepthParams",
      "msg": "DepthParams out of allowed range."
    },
    {
      "code": 12107,
      "name": "invalidSkewParams",
      "msg": "SkewParams out of allowed range."
    },
    {
      "code": 12200,
      "name": "unauthorizedOracle",
      "msg": "Unauthorized oracle signer."
    },
    {
      "code": 12201,
      "name": "unauthorizedAdmin",
      "msg": "Unauthorized admin."
    },
    {
      "code": 12202,
      "name": "nonceNotMonotonic",
      "msg": "Oracle nonce must be strictly monotonic."
    },
    {
      "code": 12203,
      "name": "poolPaused",
      "msg": "Pool is paused."
    },
    {
      "code": 12300,
      "name": "noFreshPriceSource",
      "msg": "Curve is stale and no signed quote provided."
    },
    {
      "code": 12301,
      "name": "quoteExpired",
      "msg": "Signed quote is expired."
    },
    {
      "code": 12302,
      "name": "quoteWrongPool",
      "msg": "Signed quote pool does not match."
    },
    {
      "code": 12303,
      "name": "quoteWrongUser",
      "msg": "Signed quote user does not match transaction signer."
    },
    {
      "code": 12304,
      "name": "quoteDirectionMismatch",
      "msg": "Signed quote direction does not match instruction direction."
    },
    {
      "code": 12305,
      "name": "quoteSizeMismatch",
      "msg": "Signed quote input_amount does not match instruction input_amount."
    },
    {
      "code": 12306,
      "name": "quoteSignatureInvalid",
      "msg": "Signed quote ed25519 signature verification failed."
    },
    {
      "code": 12400,
      "name": "slippageExceeded",
      "msg": "Output amount below min_output (slippage exceeded)."
    },
    {
      "code": 12401,
      "name": "insufficientReserves",
      "msg": "Vault has insufficient balance."
    },
    {
      "code": 12500,
      "name": "wrongPool",
      "msg": "Account.pool field does not match expected pool_state."
    },
    {
      "code": 12501,
      "name": "nonceNotYetClosable",
      "msg": "Nonce marker not yet eligible for close (expiry + safety buffer not reached)."
    }
  ],
  "types": [
    {
      "name": "adminRotated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "previousAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "depthParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depthCoefBps",
            "docs": [
              "Extra spread (bps) added per `size_unit` of user size."
            ],
            "type": "u32"
          },
          {
            "name": "sizeUnit",
            "docs": [
              "Unit size that depth_coef_bps applies to (base raw token amount)."
            ],
            "type": "u64"
          },
          {
            "name": "maxDepthBps",
            "docs": [
              "Upper cap on depth_bps (bps). Prevents runaway widening."
            ],
            "type": "u16"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "inventoryWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "baseAmount",
            "type": "u64"
          },
          {
            "name": "quoteAmount",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "oracleSignerRotated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "previousSigner",
            "type": "pubkey"
          },
          {
            "name": "newSigner",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "oracleUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "oracleSigner",
            "type": "pubkey"
          },
          {
            "name": "newFairValue",
            "type": "u64"
          },
          {
            "name": "newSpreadBps",
            "type": "u16"
          },
          {
            "name": "newNonce",
            "type": "u64"
          },
          {
            "name": "newTtl",
            "type": "u8"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracleSigner",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "initialFairValue",
            "type": "u64"
          },
          {
            "name": "initialSpreadBps",
            "type": "u16"
          },
          {
            "name": "initialModeTtl",
            "type": "u8"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolPausedChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "authorizedOracleSigner",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "baseVault",
            "type": "pubkey"
          },
          {
            "name": "quoteVault",
            "type": "pubkey"
          },
          {
            "name": "fairValue",
            "type": "u64"
          },
          {
            "name": "spreadBps",
            "type": "u16"
          },
          {
            "name": "depthCurveParams",
            "type": {
              "defined": {
                "name": "depthParams"
              }
            }
          },
          {
            "name": "inventorySkewParams",
            "type": {
              "defined": {
                "name": "skewParams"
              }
            }
          },
          {
            "name": "lastOracleUpdateSlot",
            "type": "u64"
          },
          {
            "name": "oracleNonce",
            "docs": [
              "`update_oracle` monotonic counter; prevents replay."
            ],
            "type": "u64"
          },
          {
            "name": "currentModeTtl",
            "docs": [
              "0 = forced stale (Mode C); 1..=MAX_TTL_SLOTS otherwise."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "baseVaultBump",
            "type": "u8"
          },
          {
            "name": "quoteVaultBump",
            "type": "u8"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "quoteMarkerClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "closer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "expirySlot",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "quoteNonceMarker",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "docs": [
              "Which pool this nonce belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "docs": [
              "The nonce value this marker represents."
            ],
            "type": "u64"
          },
          {
            "name": "expirySlot",
            "docs": [
              "Used to determine when close is allowed (expiry + safety buffer must elapse)."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "side",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "buy"
          },
          {
            "name": "sell"
          }
        ]
      }
    },
    {
      "name": "signedQuote",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "direction",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "inputAmount",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "expirySlot",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "signature",
            "docs": [
              "ed25519 signature over Borsh(SignedQuoteMessage). On-chain verification",
              "cross-checks this against the ed25519 native program payload via the instructions sysvar."
            ],
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "skewParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "targetBaseBps",
            "docs": [
              "Target base weight (bps of total quote-denominated value).",
              "5000 = 50% base / 50% quote (delta-neutral)."
            ],
            "type": "u16"
          },
          {
            "name": "skewCoefBps",
            "docs": [
              "Per-bps-of-imbalance offset added to mid (bps)."
            ],
            "type": "u16"
          },
          {
            "name": "maxSkewOffsetBps",
            "docs": [
              "Absolute cap on skew_offset (bps)."
            ],
            "type": "u16"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                10
              ]
            }
          }
        ]
      }
    },
    {
      "name": "swapExecuted",
      "docs": [
        "`mode`: 0=curve fresh path (PropAMM), 1=RFQ fallback"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "direction",
            "type": "u8"
          },
          {
            "name": "mode",
            "type": "u8"
          },
          {
            "name": "inputAmount",
            "type": "u64"
          },
          {
            "name": "outputAmount",
            "type": "u64"
          },
          {
            "name": "executionPrice",
            "type": "u64"
          },
          {
            "name": "quoteNonce",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "maxDepthBps",
      "docs": [
        "Upper bound on DepthParams.max_depth_bps (5%)."
      ],
      "type": "u16",
      "value": "500"
    },
    {
      "name": "maxSkewOffsetBps",
      "docs": [
        "Upper bound on SkewParams.max_skew_offset_bps (5%)."
      ],
      "type": "u16",
      "value": "500"
    },
    {
      "name": "maxSpreadBps",
      "docs": [
        "Maximum spread = 10% (sanity guard)."
      ],
      "type": "u16",
      "value": "1000"
    },
    {
      "name": "maxTtlSlots",
      "docs": [
        "Maximum TTL in slots. v0 operating values: Mode A=1, B=3, C=0; cap includes margin."
      ],
      "type": "u8",
      "value": "8"
    },
    {
      "name": "poolSeed",
      "type": "bytes",
      "value": "[112, 111, 111, 108]"
    },
    {
      "name": "priceScale",
      "docs": [
        "Integer scale for fair_value / price (1e6)."
      ],
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "quoteUsedSeed",
      "type": "bytes",
      "value": "[113, 117, 111, 116, 101, 95, 117, 115, 101, 100]"
    },
    {
      "name": "safetyBufferSlots",
      "docs": [
        "Buffer for the close condition of QuoteNonceMarker (`expiry_slot + buffer < now`).",
        "~1 minute assuming 400ms slots."
      ],
      "type": "u64",
      "value": "150"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
