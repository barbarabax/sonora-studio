// Sonora.exe: starts Sonora Studio from the folder it sits in and opens the browser.
// Built by scripts/make-portable.mjs with the C# compiler that ships with Windows (no extra tools).
//   Sonora.exe          start Sonora (if it is already running, only open the browser)
//   Sonora.exe --stop   ask a running Sonora to stop
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string Title = "Sonora Studio";

    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string url = "http://127.0.0.1:" + ReadPort(root);
        if (args.Length > 0 && args[0] == "--stop")
        {
            Stop(url);
            return 0;
        }
        if (IsRunning(url))
        {
            Open(url);
            return 0;
        }
        string node = Path.Combine(root, "runtime", "node", "node.exe");
        if (!File.Exists(node)) node = FindOnPath("node.exe");
        if (node == null)
        {
            MessageBox.Show("Node.js 22 or newer was not found.\n\nUse the portable download (it includes Node.js) or install Node.js from nodejs.org, then start Sonora again.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        int major = NodeMajor(node);
        if (major < 22)
        {
            MessageBox.Show("Node.js 22 or newer is needed (found version " + major + ").\n\nUse the portable download or update Node.js from nodejs.org.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        ProcessStartInfo start = new ProcessStartInfo(node, "server.mjs");
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process.Start(start);
        for (int attempt = 0; attempt < 60; attempt++)
        {
            Thread.Sleep(500);
            if (IsRunning(url))
            {
                Open(url);
                return 0;
            }
        }
        MessageBox.Show("Sonora Studio did not start.\n\nDouble-click \"Sonora (show errors).cmd\" in this folder to see what went wrong.", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }

    static int ReadPort(string root)
    {
        try
        {
            string text = File.ReadAllText(Path.Combine(root, "config.json"));
            Match match = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
            if (match.Success) return int.Parse(match.Groups[1].Value);
        }
        catch (Exception) { }
        return 3210;
    }

    static bool IsRunning(string url)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/state");
            request.Timeout = 2000;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK;
        }
        catch (Exception) { return false; }
    }

    static void Stop(string url)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/shutdown");
            request.Method = "POST";
            request.Headers.Add("X-Sonora", "1");
            request.ContentLength = 0;
            request.Timeout = 5000;
            request.GetResponse().Close();
        }
        catch (Exception) { }
    }

    static void Open(string url)
    {
        try { Process.Start(url); }
        catch (Exception) { MessageBox.Show("Sonora Studio is running. Open " + url + " in your browser.", Title); }
    }

    static string FindOnPath(string file)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string folder in path.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(folder.Trim('"'), file);
                if (File.Exists(candidate)) return candidate;
            }
            catch (Exception) { }
        }
        return null;
    }

    static int NodeMajor(string node)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(node, "--version");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            using (Process process = Process.Start(info))
            {
                string text = process.StandardOutput.ReadToEnd().Trim();
                process.WaitForExit(5000);
                Match match = Regex.Match(text, "^v(\\d+)");
                if (match.Success) return int.Parse(match.Groups[1].Value);
            }
        }
        catch (Exception) { }
        return 0;
    }
}
