# Terminology

The words this project uses for its domain. Entry format: [README.md](README.md#terminology-entry).

## Language

### Escrow
Money that a buyer pays in and that the app holds until the seller completes a **Milestone** and a second person approves the **Payout**.\
_Refs:_ **Milestone**, **Payout**\
_Avoid_: wallet, vault

### Milestone
One agreed step of a deal. The seller sends evidence that the step is complete, and its share of the **Escrow** can then become a **Payout**.\
_Parent:_ **Escrow**\
_Avoid_: stage, tranche

### Payout
Money that leaves **Escrow** and goes to the seller, after a **Milestone** has evidence and a second person approves it.\
_Refs:_ **Escrow**, **Milestone**\
_Avoid_: release, disbursement, withdrawal

## Flagged ambiguities

### Payout vs release
A **Payout** moves money out of **Escrow**. A release is a software release of this app. Never use "release" for money.
