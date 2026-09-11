use crate::domain::Verdict;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceLevel {
    Mock,
    Synthetic,
    Runtime,
    Desktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerificationObservation {
    pub exit_code: i32,
    pub executed: usize,
    pub skipped: usize,
    pub level: EvidenceLevel,
}

impl VerificationObservation {
    pub fn verdict(self) -> Verdict {
        if self.exit_code != 0
            || self.executed == 0
            || self.skipped > 0
            || self.level == EvidenceLevel::Mock
        {
            Verdict::Unassessed
        } else if matches!(self.level, EvidenceLevel::Runtime | EvidenceLevel::Desktop) {
            Verdict::Verified
        } else {
            Verdict::PartiallyVerified
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalContext {
    pub plan_approved: bool,
    pub audit_passed: bool,
}

#[derive(Debug, Default)]
pub struct ActionAuthority {
    explicit: HashSet<String>,
}

impl ActionAuthority {
    pub fn new(actions: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            explicit: actions.into_iter().map(Into::into).collect(),
        }
    }

    pub fn allows(&self, action: &str, _context: ApprovalContext) -> bool {
        self.explicit.contains(action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_skipped_and_mock_ranges_never_verify() {
        for observation in [
            VerificationObservation {
                exit_code: 0,
                executed: 0,
                skipped: 0,
                level: EvidenceLevel::Synthetic,
            },
            VerificationObservation {
                exit_code: 0,
                executed: 2,
                skipped: 2,
                level: EvidenceLevel::Synthetic,
            },
            VerificationObservation {
                exit_code: 0,
                executed: 2,
                skipped: 0,
                level: EvidenceLevel::Mock,
            },
        ] {
            assert_eq!(observation.verdict(), Verdict::Unassessed);
        }
    }

    #[test]
    fn plan_and_audit_do_not_grant_external_action_authority() {
        let authority = ActionAuthority::default();
        let context = ApprovalContext {
            plan_approved: true,
            audit_passed: true,
        };
        for action in ["commit", "push", "release", "delete"] {
            assert!(!authority.allows(action, context));
        }
    }
}
