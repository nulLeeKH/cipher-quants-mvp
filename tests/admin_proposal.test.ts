import { Keypair, PublicKey } from "@solana/web3.js";

import {
  setupTestContext,
  setupPool,
  fundAccount,
  TestContext,
  PoolFixture,
} from "./helpers/setup";
import {
  deriveAdminProposal,
  parseEventsFromTx,
} from "../sdk/dist";

// ============================================================================
// Admin-rotation 2-step flow (propose / accept / cancel)
// docs/SPECIFICATION.md §3.9–§3.11
//
// Seed range 100–199 (per CLAUDE.md `Seed ID Ranges`).
// Each test uses a freshly-created pool to avoid order dependence.
// ============================================================================

const SEED_BASE = 100;
let seedCounter = SEED_BASE;
const nextSeed = () => seedCounter++;

describe("propose_admin / accept_admin / cancel_admin_proposal", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  // ==========================================================================
  // propose_admin
  // ==========================================================================
  describe("propose_admin", () => {
    it("admin can propose a new admin (happy path)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin = Keypair.generate();
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      const sig = await ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Account exists and decodes
      const proposal = await ctx.program.account.adminRotationProposal.fetch(
        adminProposal
      );
      expect(proposal.pool.toString()).toBe(fx.poolState.toString());
      expect(proposal.proposedBy.toString()).toBe(fx.admin.publicKey.toString());
      expect(proposal.newAdmin.toString()).toBe(newAdmin.publicKey.toString());
      expect(proposal.createdSlot.gtn(0)).toBe(true);

      // Event emitted
      const events = await parseEventsFromTx(ctx.provider, sig);
      const ev = events.find((e) => e.name === "AdminProposalCreated");
      expect(ev).toBeDefined();
      const data: any = ev!.data;
      expect(data.pool.toString()).toBe(fx.poolState.toString());
      expect(data.proposedBy.toString()).toBe(fx.admin.publicKey.toString());
      expect(data.newAdmin.toString()).toBe(newAdmin.publicKey.toString());
    });

    it("rejects propose from non-admin (UnauthorizedAdmin)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const imposter = Keypair.generate();
      await fundAccount(ctx.provider, imposter.publicKey, 2);
      const newAdmin = Keypair.generate();
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      await expect(
        ctx.program.methods
          .proposeAdmin(newAdmin.publicKey)
          .accountsPartial({
            admin: imposter.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([imposter])
          .rpc()
      ).rejects.toThrow(/UnauthorizedAdmin/);
    });

    it("rejects zero pubkey new_admin (InvalidNewAdmin)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      await expect(
        ctx.program.methods
          .proposeAdmin(PublicKey.default)
          .accountsPartial({
            admin: fx.admin.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([fx.admin])
          .rpc()
      ).rejects.toThrow(/InvalidNewAdmin/);
    });

    it("rejects new_admin == current admin (InvalidNewAdmin)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      await expect(
        ctx.program.methods
          .proposeAdmin(fx.admin.publicKey)
          .accountsPartial({
            admin: fx.admin.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([fx.admin])
          .rpc()
      ).rejects.toThrow(/InvalidNewAdmin/);
    });

    it("rejects re-propose without cancel (account already exists)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin1 = Keypair.generate();
      const newAdmin2 = Keypair.generate();
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      // First propose: succeeds.
      await ctx.program.methods
        .proposeAdmin(newAdmin1.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Second propose: fails because `system_program::create_account` rejects
      // an already-existing account. The exact error message comes from the
      // system program ("account in use" / similar) — match the SystemProgram
      // class of failure rather than a specific protocol code.
      await expect(
        ctx.program.methods
          .proposeAdmin(newAdmin2.publicKey)
          .accountsPartial({
            admin: fx.admin.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([fx.admin])
          .rpc()
      ).rejects.toThrow(); // either "already in use" or InvalidNewAdmin via our empty-check
    });
  });

  // ==========================================================================
  // cancel_admin_proposal
  // ==========================================================================
  describe("cancel_admin_proposal", () => {
    it("admin can cancel an outstanding proposal (rent reclaimed)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin = Keypair.generate();
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      // Snapshot admin balance before propose.
      const beforePropose = await ctx.provider.connection.getBalance(
        fx.admin.publicKey
      );

      await ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      const afterPropose = await ctx.provider.connection.getBalance(
        fx.admin.publicKey
      );
      // Propose paid rent (account exists now).
      expect(afterPropose).toBeLessThan(beforePropose);

      const sig = await ctx.program.methods
        .cancelAdminProposal()
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Account closed: getAccountInfo returns null.
      const acc = await ctx.provider.connection.getAccountInfo(adminProposal);
      expect(acc).toBeNull();

      // Rent refunded to admin: balance ≈ before-propose (minus the two tx fees).
      const afterCancel = await ctx.provider.connection.getBalance(
        fx.admin.publicKey
      );
      const rentApprox = beforePropose - afterPropose;
      // afterCancel should regain the rent (minus a couple of 5000-lamport fees).
      expect(afterCancel).toBeGreaterThan(afterPropose + rentApprox - 50_000);

      // Event
      const events = await parseEventsFromTx(ctx.provider, sig);
      const ev = events.find((e) => e.name === "AdminProposalCancelled");
      expect(ev).toBeDefined();
      const data: any = ev!.data;
      expect(data.cancelledNewAdmin.toString()).toBe(
        newAdmin.publicKey.toString()
      );
    });

    it("rejects cancel from non-admin (UnauthorizedAdmin)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin = Keypair.generate();
      const imposter = Keypair.generate();
      await fundAccount(ctx.provider, imposter.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      await ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      await expect(
        ctx.program.methods
          .cancelAdminProposal()
          .accountsPartial({
            admin: imposter.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([imposter])
          .rpc()
      ).rejects.toThrow(/UnauthorizedAdmin/);
    });
  });

  // ==========================================================================
  // accept_admin
  // ==========================================================================
  describe("accept_admin", () => {
    it("proposed new admin can accept (pool.admin updates, account closed)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin = Keypair.generate();
      await fundAccount(ctx.provider, newAdmin.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      await ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      const sig = await ctx.program.methods
        .acceptAdmin()
        .accountsPartial({
          newAdmin: newAdmin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([newAdmin])
        .rpc();

      // Pool admin rotated.
      const pool: any = await ctx.program.account.poolState.fetch(fx.poolState);
      expect(pool.admin.toString()).toBe(newAdmin.publicKey.toString());

      // Proposal closed.
      const acc = await ctx.provider.connection.getAccountInfo(adminProposal);
      expect(acc).toBeNull();

      // Event emitted with the right pubkeys.
      const events = await parseEventsFromTx(ctx.provider, sig);
      const ev = events.find((e) => e.name === "AdminRotated");
      expect(ev).toBeDefined();
      const data: any = ev!.data;
      expect(data.previousAdmin.toString()).toBe(fx.admin.publicKey.toString());
      expect(data.newAdmin.toString()).toBe(newAdmin.publicKey.toString());
    });

    it("rejects accept from a signer that is not the proposed new admin (UnauthorizedAdmin)", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin = Keypair.generate();
      const imposter = Keypair.generate();
      await fundAccount(ctx.provider, imposter.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      await ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      await expect(
        ctx.program.methods
          .acceptAdmin()
          .accountsPartial({
            newAdmin: imposter.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([imposter])
          .rpc()
      ).rejects.toThrow(/UnauthorizedAdmin/);
    });

    it("rejects stale proposal (admin changed via single-step rotate between propose and accept) — ProposalStale", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const targetAdmin = Keypair.generate();
      await fundAccount(ctx.provider, targetAdmin.publicKey, 2);
      const intermediateAdmin = Keypair.generate();
      await fundAccount(ctx.provider, intermediateAdmin.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      // Step 1: original admin proposes targetAdmin.
      await ctx.program.methods
        .proposeAdmin(targetAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Step 2: original admin rotates to intermediateAdmin via the legacy
      // single-step `rotate_admin`. The outstanding proposal now references
      // a proposer that is no longer pool.admin — stale.
      await ctx.program.methods
        .rotateAdmin(intermediateAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
        })
        .signers([fx.admin])
        .rpc();

      // Step 3: targetAdmin tries to accept — must be rejected as stale.
      await expect(
        ctx.program.methods
          .acceptAdmin()
          .accountsPartial({
            newAdmin: targetAdmin.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([targetAdmin])
          .rpc()
      ).rejects.toThrow(/ProposalStale/);
    });

    it("stale proposal can be cleaned up by the *new* current admin (post single-step rotate)", async () => {
      // Edge case: if an outstanding proposal is orphaned by an intervening
      // single-step rotation, the admin_proposal PDA is locked until someone
      // calls cancel_admin_proposal. The original proposer no longer matches
      // pool.admin (UnauthorizedAdmin), so cancel must succeed via the NEW
      // current admin — otherwise the PDA would block all future propose_admin
      // calls forever.
      const fx = await setupPool(ctx, nextSeed());
      const targetAdmin = Keypair.generate();
      const intermediateAdmin = Keypair.generate();
      await fundAccount(ctx.provider, intermediateAdmin.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      // 1. Original admin proposes targetAdmin.
      await ctx.program.methods
        .proposeAdmin(targetAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // 2. Original admin rotates to intermediateAdmin via single-step. The
      //    proposal is now stale.
      await ctx.program.methods
        .rotateAdmin(intermediateAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
        })
        .signers([fx.admin])
        .rpc();

      // 3. Original admin attempts cancel → UnauthorizedAdmin (no longer pool.admin).
      await expect(
        ctx.program.methods
          .cancelAdminProposal()
          .accountsPartial({
            admin: fx.admin.publicKey,
            poolState: fx.poolState,
            adminProposal,
          })
          .signers([fx.admin])
          .rpc()
      ).rejects.toThrow(/UnauthorizedAdmin/);

      // 4. New current admin (intermediateAdmin) cancels → success.
      await ctx.program.methods
        .cancelAdminProposal()
        .accountsPartial({
          admin: intermediateAdmin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([intermediateAdmin])
        .rpc();

      // 5. PDA is now free — fresh propose_admin from intermediateAdmin works.
      const newTarget = Keypair.generate();
      await ctx.program.methods
        .proposeAdmin(newTarget.publicKey)
        .accountsPartial({
          admin: intermediateAdmin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([intermediateAdmin])
        .rpc();
    });
  });

  // ==========================================================================
  // End-to-end 2-step rotation
  // ==========================================================================
  describe("end-to-end 2-step rotation", () => {
    it("propose → accept invalidates the old admin's privileges", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const newAdmin = Keypair.generate();
      await fundAccount(ctx.provider, newAdmin.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      // Propose
      await ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Accept
      await ctx.program.methods
        .acceptAdmin()
        .accountsPartial({
          newAdmin: newAdmin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([newAdmin])
        .rpc();

      // Old admin's set_paused must now fail with UnauthorizedAdmin.
      await expect(
        ctx.program.methods
          .setPaused(true)
          .accountsPartial({
            admin: fx.admin.publicKey,
            poolState: fx.poolState,
          })
          .signers([fx.admin])
          .rpc()
      ).rejects.toThrow(/UnauthorizedAdmin/);

      // New admin's set_paused must succeed.
      await ctx.program.methods
        .setPaused(true)
        .accountsPartial({
          admin: newAdmin.publicKey,
          poolState: fx.poolState,
        })
        .signers([newAdmin])
        .rpc();
      const pool: any = await ctx.program.account.poolState.fetch(fx.poolState);
      expect(pool.paused).toBe(true);
    });

    it("propose → cancel → re-propose-different → accept works", async () => {
      const fx = await setupPool(ctx, nextSeed());
      const candidateA = Keypair.generate();
      const candidateB = Keypair.generate();
      await fundAccount(ctx.provider, candidateB.publicKey, 2);
      const [adminProposal] = deriveAdminProposal(fx.poolState);

      // Propose A
      await ctx.program.methods
        .proposeAdmin(candidateA.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Cancel
      await ctx.program.methods
        .cancelAdminProposal()
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Re-propose with B
      await ctx.program.methods
        .proposeAdmin(candidateB.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([fx.admin])
        .rpc();

      // Accept by B
      await ctx.program.methods
        .acceptAdmin()
        .accountsPartial({
          newAdmin: candidateB.publicKey,
          poolState: fx.poolState,
          adminProposal,
        })
        .signers([candidateB])
        .rpc();

      const pool: any = await ctx.program.account.poolState.fetch(fx.poolState);
      expect(pool.admin.toString()).toBe(candidateB.publicKey.toString());
    });
  });
});
