using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace Velmren.Delivery;

internal static class TransportTests
{
    public static async Task<int> Main(string[] args) => await Program.RunTransportTests(args.Single());
}

internal sealed class ScriptedHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken);
}

internal static partial class Program
{
    static readonly List<string> TransportChecks = [];
    static void AssertTest(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    static void CheckTest(string name, Action action) { action(); TransportChecks.Add(name); }
    static async Task CheckTestAsync(string name, Func<Task> action) { await action(); TransportChecks.Add(name); }
    static void RejectTest<T>(Action action) where T : Exception
    {
        try { action(); } catch (T) { return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name);
    }
    static async Task RejectTestAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); } catch (T) { return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name);
    }
    static HttpResponseMessage RedirectTest(int status, string target)
    {
        var response = new HttpResponseMessage((HttpStatusCode)status);
        response.Headers.TryAddWithoutValidation("Location", target);
        response.Headers.TryAddWithoutValidation("Set-Cookie", "private=session");
        return response;
    }
    static DeliveryPolicy TestPolicy(string feed = "https://updates.example.invalid/preview/win-x64/") =>
        new("Release", 2, "velmren", "preview", "win-x64", feed, ["cdn.example.invalid"]);
    static Manifest TestManifest(byte[] bytes) => new(2, "velmren", "1.2.3.4", "velmren-1.2.3.4.zip", bytes.Length,
        Convert.ToHexStringLower(SHA256.HashData(bytes)), 0, [new PayloadFile("delivery-app.json", 0, new string('0', 64))],
        "preview", "win-x64", "https://cdn.example.invalid/releases/1.2.3.4.zip?signature=secret-test-token");

    internal static async Task<int> RunTransportTests(string work)
    {
        work = Path.GetFullPath(work);
        if (Directory.Exists(work)) throw new InvalidOperationException("Use a new test directory.");
        Directory.CreateDirectory(work);
        var policy = TestPolicy();
        var feed = new Uri(policy.FeedUri!);
        var manifest = TestManifest(Encoding.UTF8.GetBytes("verified resumed package bytes"));
        CheckTest("development-default-policy", () => { AssertTest(!Policy.IsRelease, "Default mode changed."); Policy.ValidateFeed("http://127.0.0.1:1234/"); });
        CheckTest("release-policy-valid", () => policy.Validate("Release"));
        foreach (var invalid in new[] {
            policy with { Mode = "Development" }, policy with { Schema = 1 }, policy with { Product = "other" },
            policy with { Channel = "stable" }, policy with { Platform = "linux-x64" }, policy with { FeedUri = "http://updates.example.invalid/" },
            policy with { FeedUri = "https://updates.example.invalid/?secret=value" }, policy with { AllowedRedirectHosts = ["*.example.invalid"] },
            policy with { AllowedRedirectHosts = ["cdn.example.invalid:443"] } })
            CheckTest("invalid-policy-" + TransportChecks.Count, () => RejectTest<InvalidDataException>(() => invalid.Validate("Release")));
        foreach (var uri in new[] { "http://updates.example.invalid/preview/win-x64/", "https://cdn.example.invalid/preview/win-x64/", "https://updates.example.invalid/another/", policy.FeedUri + "?token=secret" })
            CheckTest("exact-feed-" + TransportChecks.Count, () => RejectTest<InvalidDataException>(() => policy.ValidateFeed(uri)));
        CheckTest("schema2-identity", () => policy.ValidateIdentity(manifest));
        foreach (var invalid in new[] { manifest with { Schema = 1 }, manifest with { Product = "velmren-local-development" },
            manifest with { Channel = "stable" }, manifest with { Platform = "linux-x64" }, manifest with { Channel = null } })
            CheckTest("wrong-manifest-identity-" + TransportChecks.Count, () => RejectTest<InvalidDataException>(() => policy.ValidateIdentity(invalid)));
        CheckTest("development-rejects-release", () => RejectTest<InvalidDataException>(() => Policy.ValidateIdentity(manifest)));
        CheckTest("optional-package-uri", () => AssertTest(policy.PackageUri(feed, manifest with { PackageUrl = null }).AbsoluteUri == new Uri(feed, manifest.Package).AbsoluteUri, "Package fallback differs."));
        CheckTest("signed-package-uri-query", () => AssertTest(policy.PackageUri(feed, manifest).Query == "?signature=secret-test-token", "Signed CDN query lost."));
        CheckTest("immutable-package-uri", () => RejectTest<InvalidDataException>(() => SameRelease(manifest, manifest with { PackageUrl = manifest.PackageUrl + "-changed" })));
        foreach (var status in new[] { 301, 302, 303, 307, 308 })
        {
            await CheckTestAsync("redirect-" + status + "-fresh-range-only", async () =>
            {
                var calls = 0;
                using var transport = new DeliveryTransport(new ScriptedHandler((request, _) =>
                {
                    AssertTest(request.Method == HttpMethod.Get && request.Headers.Range?.ToString() == "bytes=7-", "Range/method changed.");
                    AssertTest(request.Headers.Count() == 1 && request.Content is null, "Unexpected forwarded header/content.");
                    if (++calls == 1) return Task.FromResult(RedirectTest(status, manifest.PackageUrl!));
                    AssertTest(request.RequestUri!.AbsoluteUri == manifest.PackageUrl, "Redirect query changed.");
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
                }));
                using var response = await transport.GetAsync(new Uri(feed, "latest.json"), policy, 7, default);
                AssertTest(calls == 2, "Expected one redirect.");
            });
        }
        await CheckTestAsync("relative-redirect-no-range", async () =>
        {
            var calls = 0;
            using var transport = new DeliveryTransport(new ScriptedHandler((request, _) =>
            {
                AssertTest(!request.Headers.Any(), "Unexpected manifest request headers.");
                if (++calls == 1) return Task.FromResult(RedirectTest(302, "../objects/latest.json?sig=relative"));
                AssertTest(request.RequestUri == new Uri(feed, "../objects/latest.json?sig=relative"), "Relative resolution failed.");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
            }));
            using var response = await transport.GetAsync(new Uri(feed, "latest.json"), policy, null, default);
        });
        foreach (var target in new[] { "http://cdn.example.invalid/file", "https://evil.example.invalid/file", "https://cdn.example.invalid.evil.test/file",
            "https://user:password@cdn.example.invalid/file", "https://cdn.example.invalid/file#fragment", "file:///C:/data.zip", "https://cdn.example.invalid\\evil/file" })
        {
            await CheckTestAsync("redirect-denied-" + TransportChecks.Count, async () =>
            {
                var calls = 0;
                using var transport = new DeliveryTransport(new ScriptedHandler((_, _) => { calls++; return Task.FromResult(RedirectTest(302, target)); }));
                await RejectTestAsync<InvalidDataException>(() => transport.GetAsync(new Uri(feed, "latest.json"), policy, null, default));
                AssertTest(calls == 1, "Forbidden redirect was requested.");
            });
        }
        foreach (var follow in new[] { 5, 6 })
            await CheckTestAsync("redirect-bound-" + follow, async () =>
            {
                var calls = 0;
                using var transport = new DeliveryTransport(new ScriptedHandler((_, _) => Task.FromResult(++calls <= follow
                    ? RedirectTest(307, "https://cdn.example.invalid/hop?count=" + calls)
                    : new HttpResponseMessage(HttpStatusCode.OK))));
                if (follow == 5) { using var response = await transport.GetAsync(new Uri(feed, "latest.json"), policy, null, default); }
                else await RejectTestAsync<InvalidDataException>(() => transport.GetAsync(new Uri(feed, "latest.json"), policy, null, default));
                AssertTest(calls == 6, "Redirect bound is not exactly five follows.");
            });
        await CheckTestAsync("development-redirect-denied", async () =>
        {
            using var transport = new DeliveryTransport(new ScriptedHandler((_, _) => Task.FromResult(RedirectTest(302, "http://127.0.0.1:1234/other"))));
            await RejectTestAsync<InvalidDataException>(() => transport.GetAsync(new Uri("http://127.0.0.1:1234/latest.json"), Policy, null, default));
        });
        await CheckTestAsync("missing-location-denied", async () =>
        {
            using var transport = new DeliveryTransport(new ScriptedHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Found))));
            await RejectTestAsync<InvalidDataException>(() => transport.GetAsync(new Uri(feed, "latest.json"), policy, null, default));
        });
        await CheckTestAsync("redirect-cancellation", async () =>
        {
            using var cancellation = new CancellationTokenSource();
            var calls = 0;
            using var transport = new DeliveryTransport(new ScriptedHandler((_, _) => { calls++; cancellation.Cancel(); return Task.FromResult(RedirectTest(302, manifest.PackageUrl!)); }));
            await RejectTestAsync<OperationCanceledException>(() => transport.GetAsync(new Uri(feed, "latest.json"), policy, null, cancellation.Token));
            AssertTest(calls == 1, "Cancellation allowed another request.");
        });
        await CheckTestAsync("network-error-query-redacted", async () =>
        {
            using var transport = new DeliveryTransport(new ScriptedHandler((_, _) => throw new HttpRequestException("Failed " + manifest.PackageUrl)));
            try { await transport.GetAsync(new Uri(manifest.PackageUrl!), policy, null, default); }
            catch (HttpRequestException error) { AssertTest(!error.ToString().Contains("secret-test-token"), "Query leaked in transport error."); return; }
            throw new InvalidOperationException("Expected network failure.");
        });
        CheckTest("diagnostic-query-redacted", () => AssertTest(!SafeError(new IOException("Read failed " + manifest.PackageUrl)).Contains("secret-test-token"), "Query leaked in diagnostics."));
        CheckTest("production-handler-security", () =>
        {
            using var handler = DeliveryTransport.CreateHandler();
            AssertTest(!handler.AllowAutoRedirect && !handler.UseCookies && !handler.UseDefaultCredentials && handler.Credentials is null
                && !handler.PreAuthenticate && !handler.UseProxy && handler.ServerCertificateCustomValidationCallback is null, "Unsafe HTTP handler configuration.");
        });
        await TestDownloads(work, policy, feed);
        await CheckTestAsync("real-tls-untrusted-certificate-rejected", TestUntrustedTls);
        await File.WriteAllTextAsync(Path.Combine(work, "result.json"), JsonSerializer.Serialize(new { passed = TransportChecks.Count, checks = TransportChecks }, Json));
        Console.WriteLine(JsonSerializer.Serialize(new { passed = TransportChecks.Count, result = Path.Combine(work, "result.json") }));
        return 0;
    }

    static async Task TestDownloads(string work, DeliveryPolicy policy, Uri feed)
    {
        var bytes = Encoding.UTF8.GetBytes("verified resumed package bytes");
        var manifest = TestManifest(bytes);
        foreach (var scenario in new[] { "resume", "restart-200", "bad-range", "bad-hash", "oversize", "incomplete" })
        {
            await CheckTestAsync("redirect-download-" + scenario, async () =>
            {
                var root = Path.Combine(work, scenario);
                Directory.CreateDirectory(Path.Combine(root, "downloads"));
                var partial = Path.Combine(root, "downloads", manifest.Sha256 + ".zip.part");
                await File.WriteAllBytesAsync(partial, bytes[..7]);
                var calls = 0;
                using var transport = new DeliveryTransport(new ScriptedHandler((request, _) =>
                {
                    AssertTest(request.Headers.Range?.ToString() == "bytes=7-", "Resume offset not carried across redirect.");
                    if (++calls == 1) return Task.FromResult(RedirectTest(307, "https://cdn.example.invalid/object?signature=download-secret"));
                    var content = scenario == "restart-200" ? bytes : bytes[7..];
                    if (scenario == "bad-hash") content = Enumerable.Repeat((byte)'x', content.Length).ToArray();
                    if (scenario == "oversize") content = [.. content, (byte)'x'];
                    if (scenario == "incomplete") content = content[..^2];
                    var response = new HttpResponseMessage(scenario == "restart-200" ? HttpStatusCode.OK : HttpStatusCode.PartialContent)
                    { Content = new StreamContent(new MemoryStream(content)) };
                    if (scenario != "restart-200") response.Content.Headers.ContentRange = new ContentRangeHeaderValue(scenario == "bad-range" ? 6 : 7, bytes.Length - 1, bytes.Length);
                    return Task.FromResult(response);
                }));
                if (scenario is "resume" or "restart-200")
                {
                    var complete = await Download(root, feed, manifest, default, transport, policy);
                    AssertTest(File.ReadAllBytes(complete).SequenceEqual(bytes) && !File.Exists(partial), "Verified complete package differs.");
                }
                else if (scenario == "bad-hash")
                {
                    await RejectTestAsync<CryptographicException>(() => Download(root, feed, manifest, default, transport, policy));
                    AssertTest(Directory.GetFiles(Path.GetDirectoryName(partial)!, "*.rejected-*").Length == 1, "Rejected hash was not quarantined.");
                }
                else
                {
                    await RejectTestAsync<InvalidDataException>(() => Download(root, feed, manifest, default, transport, policy));
                    AssertTest(!File.Exists(partial[..^5]), "Invalid archive was promoted.");
                }
                var log = Path.Combine(root, "events.jsonl");
                AssertTest(!File.Exists(log) || !File.ReadAllText(log).Contains("download-secret"), "Query leaked to event log.");
            });
        }
    }

    static async Task TestUntrustedTls()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder();
        names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddHours(1));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var server = Task.Run(async () =>
        {
            using var socket = await listener.AcceptTcpClientAsync(timeout.Token);
            using var stream = new SslStream(socket.GetStream());
            try { await stream.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate }, timeout.Token); }
            catch (Exception error) when (error is AuthenticationException or IOException) { }
        });
        var policy = TestPolicy($"https://127.0.0.1:{port}/");
        using var transport = new DeliveryTransport();
        try
        {
            using var response = await transport.GetAsync(new Uri(policy.FeedUri! + "latest.json"), policy, null, timeout.Token);
            throw new InvalidOperationException("Untrusted TLS certificate was accepted.");
        }
        catch (HttpRequestException error)
        {
            AssertTest(error.HttpRequestError == HttpRequestError.SecureConnectionError, "Expected a TLS validation failure, not another network failure.");
        }
        await server;
    }
}
