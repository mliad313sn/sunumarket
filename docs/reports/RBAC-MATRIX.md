# RBAC matrix — Phase 3 (verified by test/rbac.phase3.test.ts)

Roles: buyer · seller · rider · partner · admin. Admin passes every guard.
Rider/partner data isolation is enforced by ownership filters in queries (verified further in Phase 9).

| Route | buyer | seller | rider | partner | admin | anonymous |
|-------|-------|--------|-------|---------|-------|-----------|
| POST /auth/otp, /auth/verify, /auth/refresh | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (public) |
| GET /health, /track/{token} | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (public/tokenized) |
| GET /me, /me/export, POST /kyc/upgrade | ✓ | ✓ | ✓ | ✓ | ✓ | 401 |
| POST /auth/payout-pin | 403 | ✓ | ✓ | 403 | ✓ | 401 |
| GET /admin/kyc/queue, POST /admin/kyc/:id/decide | 403 | 403 | 403 | 403 | ✓ | 401 |
| GET /admin/fraud/queue, POST /admin/fraud/:id/review | 403 | 403 | 403 | 403 | ✓ | 401 |

Later phases append rows as routes land (orders, payments, delivery, admin config); the matrix
test extends with them.
