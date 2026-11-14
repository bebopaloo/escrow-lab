# Terminology

The words this project uses for its domain. Entry format: [README.md](README.md#terminology-entry).

## Language

### Deal
One agreement between a **Buyer** and a **Seller**: a total amount in one currency, split into **Milestones** that add up to it.\
_Refs:_ **Escrow**, **Milestone**\
_Avoid_: contract, order, trade

### Buyer
The person who creates a **Deal**, funds its **Escrow** and accepts or rejects the evidence for each **Milestone**.\
_Refs:_ **Deal**, **Seller**\
_Avoid_: payer, client, customer

### Seller
The person who does the work of a **Deal**, sends the evidence for each **Milestone** and receives each **Payout**.\
_Refs:_ **Deal**, **Buyer**\
_Avoid_: payee, supplier, vendor

### Approver
A member of escrow-lab's staff who approves a **Payout** after the **Buyer** accepts the evidence. An Approver is never the Buyer or the Seller of the Deal.\
_Refs:_ **Payout**, **Dual control**\
_Avoid_: admin, checker, reviewer

### Dual control
The rule that a **Payout** needs two different people: the **Buyer** accepts the evidence, then an **Approver** approves the Payout.\
_Refs:_ **Approver**, **Payout**\
_Avoid_: four-eyes, maker-checker

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

### Idempotency key
A unique value that the app makes once for one intended money movement, such as one **Payout**, and sends with every try of it. A partner that sees the same key again returns the first result and moves no more money.\
_Refs:_ **Payout**\
_Avoid_: request id, transaction id, nonce

## Flagged ambiguities

### Payout vs release
A **Payout** moves money out of **Escrow**. A release is a software release of this app. Never use "release" for money.
