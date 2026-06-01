-- Careers: admin-managed job postings. Each row is one open position with a
-- short summary (shown on the /careers list) and a long HTML description (shown
-- on /careers/<slug>). `apply_url` is the external application link — for Ark
-- this is the per-role TestGorilla assessment. The back office owns this table;
-- the public site reads only enabled rows, ordered by display_order.

create table if not exists careers (
  id               uuid          primary key default gen_random_uuid(),
  slug             text          not null unique,
  title            text          not null,
  team             text,
  location         text,
  employment_type  text,
  summary          text          not null,
  description      text          not null,
  apply_url        text,
  enabled          boolean       not null default true,
  display_order    integer       not null default 0,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

-- Public listing reads enabled rows in display order; index that access path.
create index if not exists careers_enabled_order_idx
  on careers (enabled, display_order, created_at);

-- Seed the two live positions from arkmedia.org/careers. Dollar-quoted bodies
-- so the HTML's apostrophes don't need escaping. Idempotent on slug.
insert into careers (slug, title, team, location, employment_type, summary, apply_url, display_order, description)
values
  (
    'history-host',
    'History Podcast Co-Host',
    'Content',
    'Remote (US)',
    'Contract',
    'Co-host an upcoming Jewish history show alongside a lead historian — bring curiosity, storytelling, and a love of human-centered narrative.',
    'https://app.testgorilla.com/s/n7y6e4s3',
    1,
    $desc$
<h2>About Ark Media</h2>
<p>Ark Media is a podcast network centered on exploring significant questions affecting Jewish life and Israel's future. We produce original programming featuring conversations with prominent thought leaders, and we aim to cultivate a globally connected community grounded in curiosity and substantive dialogue.</p>
<h2>About the Role</h2>
<p>We're seeking a co-host for a supporting position on an upcoming Jewish history program. The ideal candidate has intellectual curiosity, a passion for storytelling, and a strong interest in history. Working alongside a history expert, the co-host will help examine diverse periods, events, and figures from across the broad spectrum of Jewish history.</p>
<h2>Key Responsibilities</h2>
<ul>
<li>Record and deliver engaging weekly episode performances.</li>
<li>Study research materials and episode frameworks created by the lead host and producer.</li>
<li>Contribute a unique perspective and line of inquiry to deepen storytelling and advance narrative development.</li>
<li>Collaborate with the lead host and producer on editorial strategy and long-term show direction.</li>
</ul>
<h2>Required Qualifications</h2>
<ul>
<li>A compelling and genuine on-air communication style.</li>
<li>The capacity to examine Jewish history beyond conventional or narrow ideological frameworks.</li>
<li>Authentic enthusiasm for human-centered narratives and topic exploration.</li>
<li>A collaborative approach when working with the primary host.</li>
<li>Research proficiency and rapid subject-matter mastery.</li>
<li>An entrepreneurial mindset, with comfort navigating uncertainty and building from early stages.</li>
</ul>
<h2>Preferred Qualifications</h2>
<ul>
<li>Background in podcasting, YouTube, social media, broadcasting, or streaming.</li>
<li>Understanding of sophisticated narrative approaches beyond mainstream interpretations.</li>
<li>A deep personal commitment to history or Jewish cultural identity.</li>
</ul>
    $desc$
  ),
  (
    'senior-producer',
    'Senior Producer',
    'Content',
    'Remote (US)',
    'Full-time',
    'Lead editorial and production across our podcast portfolio, develop new shows, and build the systems and team to scale them.',
    'https://app.testgorilla.com/s/6ox08cx9',
    2,
    $desc$
<h2>About Ark Media</h2>
<p>Ark Media is a podcast network focused on examining significant questions affecting Jewish communities, Israel's trajectory, and global developments. We combine original programming with conversations featuring influential leaders and analysts.</p>
<h2>Role Overview</h2>
<p>This senior position combines editorial leadership, hands-on production work, new-show development, team management, and data-driven optimization. The role requires overseeing multiple shows while building scalable systems and mentoring staff. Compensation is $110,000–$140,000 annually, based on location and experience. The schedule is non-traditional and includes Sunday hours. Remote within the United States (other countries considered); Eastern Time availability is required. Reports to the CEO.</p>
<h2>Key Responsibilities</h2>
<h3>Content Leadership</h3>
<ul>
<li>Oversee quality and performance across the podcast portfolio.</li>
<li>Make critical editorial decisions regarding show content.</li>
<li>Apply performance metrics to refine shows and audience-engagement strategies.</li>
</ul>
<h3>Production Management</h3>
<ul>
<li>Direct end-to-end production workflows across all programs.</li>
<li>Establish standards and timelines for consistency.</li>
<li>Contribute directly to scripting, editing, fact-checking, and directing.</li>
</ul>
<h3>Analytics &amp; Strategy</h3>
<ul>
<li>Monitor downloads, retention, video metrics, and subscriber trends.</li>
<li>Transform performance data into actionable editorial improvements.</li>
<li>Identify growth patterns and format-optimization opportunities.</li>
</ul>
<h3>Team Development</h3>
<ul>
<li>Manage and mentor producers, production managers, and technical staff.</li>
<li>Provide constructive feedback supporting both work quality and professional growth.</li>
<li>Assist with hiring and onboarding processes.</li>
</ul>
<h3>New Show Development</h3>
<ul>
<li>Conceptualize and develop original programming from inception through launch.</li>
<li>Recruit hosts and contributors.</li>
<li>Test formats and iterate rapidly.</li>
</ul>
<h3>Systems Building</h3>
<ul>
<li>Create efficient production and development infrastructure.</li>
<li>Establish clear processes, roles, and responsibilities.</li>
<li>Manage calendar coordination and workflow execution.</li>
</ul>
<h2>Success Metrics</h2>
<ul>
<li>Portfolio operates independently without CEO micromanagement.</li>
<li>Launch of one new program positioned for expansion.</li>
<li>A functional production system with defined workflows and team accountability.</li>
<li>Consistent, timely outputs meeting editorial standards.</li>
</ul>
<h2>Required Qualifications</h2>
<ul>
<li>Five to eight years in podcasting or audio production, preferably journalism-related.</li>
<li>Demonstrated success producing high-quality audio content.</li>
<li>Background in news, geopolitics, or current affairs.</li>
<li>Team-management experience handling concurrent projects.</li>
<li>A track record launching new shows or formats.</li>
<li>Proficient audio and video editing capabilities.</li>
<li>Understanding of podcast analytics and platform performance metrics.</li>
</ul>
<h2>Ideal Candidate Profile</h2>
<p>Candidates should combine storytelling expertise with operational strength. They work comfortably in fast-paced environments, handle multiple priorities, and demonstrate strong editorial judgment. They bring detail-oriented thinking, a commitment to accuracy, and genuine interest in Jewish affairs and international matters.</p>
<p>The application requires a resume, three work samples, and roughly 10–15 minutes to complete supplementary questions.</p>
    $desc$
  )
on conflict (slug) do nothing;
