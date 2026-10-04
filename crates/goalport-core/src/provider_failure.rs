//! The closed set of provider-failure reason codes (AGENTS.md §3
//! prerequisite: typed provider error mapping instead of string guessing).
//!
//! ONE enum owns the wire vocabulary. Core code constructs the enum; the
//! serialized `reasonCode` strings and the frontend's union are derived from
//! this single list, and a lock test (src/…/turnErrorCopy lock + core unit
//! test) fails when the two sides drift. Legacy journaled strings parse
//! through [`ProviderFailure::parse`]; anything unknown degrades to
//! [`ProviderFailure::Failed`], never to a guessed specialty.


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFailure {
    Quota,
    Overloaded,
    AuthRequired,
    Version,
    Transport,
    Permission,
    RequestInvalid,
    Startup,
    NotInstalled,
    ContextFull,
    DeliveryUnknown,
    /// The deterministic-resume distinguishers are part of the closed set so
    /// the frontend lock covers them (merge-review round).
    ResumeSpawnFailed,
    ResumeVerificationFailed,
    Failed,
}

pub const ALL_PROVIDER_FAILURE_CODES: &[(&str, ProviderFailure)] = &[
    ("provider-quota", ProviderFailure::Quota),
    ("provider-overloaded", ProviderFailure::Overloaded),
    ("provider-auth-required", ProviderFailure::AuthRequired),
    ("provider-version", ProviderFailure::Version),
    ("provider-transport", ProviderFailure::Transport),
    ("provider-permission", ProviderFailure::Permission),
    ("provider-request-invalid", ProviderFailure::RequestInvalid),
    ("provider-startup", ProviderFailure::Startup),
    ("provider-not-installed", ProviderFailure::NotInstalled),
    ("provider-context-full", ProviderFailure::ContextFull),
    ("delivery-unknown", ProviderFailure::DeliveryUnknown),
    ("resume-spawn-failed", ProviderFailure::ResumeSpawnFailed),
    ("resume-verification-failed", ProviderFailure::ResumeVerificationFailed),
    ("provider-failed", ProviderFailure::Failed),
];

impl ProviderFailure {
    /// The wire string. One mapping; no other code may mint these strings.
    pub fn as_str(self) -> &'static str {
        ALL_PROVIDER_FAILURE_CODES
            .iter()
            .find(|(_, variant)| *variant == self)
            .map(|(code, _)| *code)
            .unwrap_or("provider-failed")
    }

    /// Parse a journaled or wire string. Unknown/absent degrades to Failed —
    /// never a guessed specialty (fail-closed mapping).
    pub fn parse(code: &str) -> Self {
        ALL_PROVIDER_FAILURE_CODES
            .iter()
            .find(|(wire, _)| *wire == code)
            .map(|(_, variant)| *variant)
            .unwrap_or(ProviderFailure::Failed)
    }

    pub fn message(self) -> &'static str {
        // The shipped user-facing copy, verbatim; provider_issue_message
        // dispatches through this enum so the text lives in one place.
        match self {
            Self::Quota => "This Runtime has reached its usage limit. You can continue after the limit resets.",
            Self::AuthRequired => "Sign in to this Runtime, then try again.",
            Self::NotInstalled => "This Runtime is not installed. Install it or choose another Runtime.",
            Self::Version => "This Runtime could not accept the request. Update it or choose another Runtime.",
            Self::RequestInvalid => "This Runtime rejected the request. Check Technical details before trying again.",
            Self::Startup => "This Runtime could not start. Check Technical details, then choose it again.",
            Self::Overloaded => "This Runtime is busy. Try another message later.",
            Self::Transport => "The Runtime connection failed. Check its session before continuing.",
            Self::Permission => "The Runtime denied this request. Check Technical details before continuing.",
            Self::DeliveryUnknown => "Message delivery is uncertain. Check the session before sending again.",
            Self::ResumeSpawnFailed | Self::ResumeVerificationFailed => "The last resume failed to start or did not verify the stored session id. Resume to try again; earlier messages will not be sent again.",
            Self::ContextFull | Self::Failed => "The Runtime could not finish this response. Check Technical details before continuing.",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_round_trips_and_unknown_degrades_to_failed() {
        for (code, variant) in ALL_PROVIDER_FAILURE_CODES {
            assert_eq!(ProviderFailure::parse(code), *variant, "{code}");
            assert_eq!(variant.as_str(), *code);
        }
        assert_eq!(ProviderFailure::parse(""), ProviderFailure::Failed);
        assert_eq!(
            ProviderFailure::parse("provider-mystery"),
            ProviderFailure::Failed
        );
        assert_eq!(
            ProviderFailure::parse("session-closed"),
            ProviderFailure::Failed,
            "turn-state codes are NOT provider failures"
        );
    }
}
