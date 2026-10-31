namespace Velmren.Delivery;

internal sealed record RegistrationValue(int Kind, string? Text = null, int? Number = null)
{
    internal static RegistrationValue String(string value) => new(1, value);
    internal static RegistrationValue Dword(int value) => new(4, Number: value);
}
internal sealed record RegistrationSnapshot(Dictionary<string, RegistrationValue> Values, int SubKeys);
internal interface IRegistrationKey : IDisposable
{
    RegistrationSnapshot Snapshot();
    void Set(string name, RegistrationValue value);
    void DeleteValue(string name);
}
internal interface IRegistrationStore
{
    IRegistrationKey? Open(string path);
    (IRegistrationKey Key, bool Created) Create(string path);
    void Delete(string path);
}

// This state machine has no Windows dependency. Fault tests use an in-memory
// store; the production adapter offers no rename or registry-flush operation.
internal static class RegistrationWriter
{
    static bool HasIdentity(RegistrationSnapshot state, string owner, string root)
    {
        var location = state.Values.GetValueOrDefault("InstallLocation");
        return state.Values.GetValueOrDefault("VelmrenOwner") == RegistrationValue.String(owner)
            && location is { Kind: 1, Text: not null } && location.Text.Equals(root, StringComparison.OrdinalIgnoreCase);
    }

    internal static void AssertWritable(RegistrationSnapshot state, string owner, string root,
        IReadOnlyDictionary<string, RegistrationValue>? recordedPlan)
    {
        if (HasIdentity(state, owner, root)) return;
        // An interrupted create can predate the first value. Only a durable plan
        // written after observing the key absent authorizes that partial state.
        if (recordedPlan is null || state.SubKeys != 0 || state.Values.Any(pair =>
            !recordedPlan.TryGetValue(pair.Key, out var expected) || pair.Value != expected))
            throw new InvalidOperationException("Another installation owns this uninstall entry, or its partial values conflict with the journal.");
    }

    internal static void Publish(IRegistrationStore store, string path, string owner, string root,
        IReadOnlyDictionary<string, RegistrationValue> desired,
        IReadOnlyDictionary<string, RegistrationValue>? recordedPlan,
        Action savePlan, Action complete, Action restorePlan, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        IRegistrationKey? key = store.Open(path);
        try
        {
            if (key is not null)
            {
                var initial = key.Snapshot();
                AssertWritable(initial, owner, root, recordedPlan);
                if (!HasIdentity(initial, owner, root))
                {
                    // Finish the ownership prefix under the old durable plan
                    // before replacing it with a newer version's metadata.
                    foreach (var name in new[] { "VelmrenOwner", "InstallLocation" })
                    { token.ThrowIfCancellationRequested(); key.Set(name, recordedPlan![name]); }
                    if (!HasIdentity(key.Snapshot(), owner, root)) throw new IOException("Recovered registry identity did not persist.");
                }
            }
            savePlan();
            token.ThrowIfCancellationRequested();
            if (key is null)
            {
                var opened = store.Create(path); key = opened.Key;
                // Do not treat this invocation's new journal as permission to
                // adopt a foreign key that won a race with our create.
                if (!opened.Created)
                {
                    try
                    {
                        if (!HasIdentity(key.Snapshot(), owner, root))
                            throw new InvalidOperationException("An existing key won the creation race; retry from the recorded plan.");
                    }
                    catch { restorePlan(); throw; }
                }
            }
            foreach (var name in new[] { "VelmrenOwner", "InstallLocation" }
                .Concat(desired.Keys.Where(name => name is not ("VelmrenOwner" or "InstallLocation" or "DisplayName")))
                .Append("DisplayName"))
            {
                token.ThrowIfCancellationRequested();
                key.Set(name, desired[name]);
            }
            token.ThrowIfCancellationRequested();
            var actual = key.Snapshot();
            if (desired.Any(pair => actual.Values.GetValueOrDefault(pair.Key) != pair.Value))
                throw new IOException("Uninstall registration verification failed.");
            // Retain the plan after completion: registry lazy writes may reach
            // disk after the filesystem journal when a machine loses power.
            complete();
        }
        finally { key?.Dispose(); }
    }

    internal static void Remove(IRegistrationStore store, string path, string owner, string root,
        IReadOnlyDictionary<string, RegistrationValue>? recordedPlan, IEnumerable<string> managedNames,
        CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        using var key = store.Open(path);
        if (key is null) return;
        var state = key.Snapshot();
        AssertWritable(state, owner, root, recordedPlan);
        var managed = managedNames.ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (state.SubKeys == 0 && state.Values.Keys.All(managed.Contains))
        {
            // Delete the key as a unit; never remove its ownership values first.
            token.ThrowIfCancellationRequested(); store.Delete(path); return;
        }
        // Unknown data stays with its provenance. DisplayName is removed first
        // so Apps no longer advertises an entry whose program was uninstalled.
        foreach (var name in new[] { "DisplayName" }.Concat(managed.Where(name =>
            name is not ("DisplayName" or "VelmrenOwner" or "InstallLocation"))))
        { token.ThrowIfCancellationRequested(); key.DeleteValue(name); }
    }
}
