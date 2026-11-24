/**
 * Curated skill taxonomy used by the deterministic matcher.
 *
 * - `aliases` are matched case-insensitively on token boundaries.
 * - `exact` aliases are matched case-sensitively (for ambiguous short names).
 * - `family` groups skills that are reasonably transferable; a missing skill
 *   gets partial credit when the profile has another skill in the same family.
 *
 * Bump TAXONOMY_VERSION whenever entries change so cached job analyses refresh.
 */
export const TAXONOMY_VERSION = 4;

export type SkillCategory =
  | 'language'
  | 'frontend'
  | 'backend'
  | 'mobile'
  | 'data'
  | 'ml'
  | 'database'
  | 'cloud'
  | 'devops'
  | 'testing'
  | 'security'
  | 'design'
  | 'product'
  | 'business'
  | 'tool'
  | 'practice'
  | 'soft';

export interface SkillDef {
  name: string;
  category: SkillCategory;
  aliases?: string[];
  exact?: string[];
  family?: string;
}

const s = (
  name: string,
  category: SkillCategory,
  aliases: string[] = [],
  family?: string,
  exact?: string[],
): SkillDef => ({ name, category, aliases, family, exact });

export const SKILLS: SkillDef[] = [
  // Languages
  s('JavaScript', 'language', ['javascript', 'ecmascript', 'es6', 'es2015'], 'js-lang', ['JS']),
  s('TypeScript', 'language', ['typescript'], 'js-lang', ['TS']),
  s('Python', 'language', ['python', 'python3']),
  s('Java', 'language', ['java'], 'jvm'),
  s('Kotlin', 'language', ['kotlin'], 'jvm'),
  s('Scala', 'language', ['scala'], 'jvm'),
  s('Go', 'language', ['golang'], undefined, ['Go']),
  s('Rust', 'language', ['rust']),
  s('C++', 'language', ['c++', 'cpp'], 'c-family'),
  s('C', 'language', ['c programming', 'c language', 'ansi c', 'embedded c'], 'c-family'),
  s('C#', 'language', ['c#', 'csharp', 'c sharp'], 'dotnet'),
  s('Ruby', 'language', ['ruby']),
  s('PHP', 'language', ['php']),
  s('Swift', 'language', ['swift programming', 'swift language'], 'apple', ['Swift']),
  s('Objective-C', 'language', ['objective-c', 'objective c', 'objc'], 'apple'),
  s('R', 'language', ['r programming', 'rstudio'], undefined, ['R']),
  s('MATLAB', 'language', ['matlab']),
  s('SQL', 'language', ['sql']),
  s('Bash', 'language', ['bash', 'shell scripting', 'shell script', 'zsh'], 'shell'),
  s('PowerShell', 'language', ['powershell'], 'shell'),
  s('Dart', 'language', ['dart']),
  s('Elixir', 'language', ['elixir']),
  s('Haskell', 'language', ['haskell']),
  s('Perl', 'language', ['perl']),
  s('Lua', 'language', ['lua']),
  s('Solidity', 'language', ['solidity']),
  s('Assembly', 'language', ['assembly language', 'x86 assembly', 'arm assembly']),
  s('VHDL', 'language', ['vhdl', 'verilog', 'systemverilog']),

  // Frontend
  s('React', 'frontend', ['react', 'react.js', 'reactjs'], 'js-ui'),
  s('Next.js', 'frontend', ['next.js', 'nextjs'], 'js-meta'),
  s('Vue', 'frontend', ['vue', 'vue.js', 'vuejs'], 'js-ui'),
  s('Nuxt', 'frontend', ['nuxt', 'nuxt.js'], 'js-meta'),
  s('Angular', 'frontend', ['angular', 'angularjs'], 'js-ui'),
  s('Svelte', 'frontend', ['svelte', 'sveltekit'], 'js-ui'),
  s('Redux', 'frontend', ['redux', 'redux toolkit'], 'state'),
  s('HTML', 'frontend', ['html', 'html5']),
  s('CSS', 'frontend', ['css', 'css3']),
  s('Sass', 'frontend', ['sass', 'scss'], 'css-tooling'),
  s('Tailwind CSS', 'frontend', ['tailwind', 'tailwindcss', 'tailwind css'], 'css-tooling'),
  s('Webpack', 'frontend', ['webpack'], 'bundler'),
  s('Vite', 'frontend', ['vite'], 'bundler'),
  s('jQuery', 'frontend', ['jquery']),
  s('Web Accessibility', 'frontend', ['accessibility', 'a11y', 'wcag', 'aria']),
  s('Chrome Extensions', 'frontend', ['chrome extension', 'chrome extensions', 'browser extension', 'browser extensions']),

  // Backend
  s('Node.js', 'backend', ['node.js', 'nodejs', 'node'], 'node-web'),
  s('Express.js', 'backend', ['express.js', 'expressjs', 'express framework'], 'node-web'),
  s('NestJS', 'backend', ['nestjs', 'nest.js'], 'node-web'),
  s('Django', 'backend', ['django'], 'python-web'),
  s('Flask', 'backend', ['flask'], 'python-web'),
  s('FastAPI', 'backend', ['fastapi'], 'python-web'),
  s('Spring Boot', 'backend', ['spring boot', 'spring framework', 'springboot', 'spring mvc'], 'jvm-web'),
  s('Ruby on Rails', 'backend', ['rails', 'ruby on rails', 'ror'], 'ruby-web'),
  s('Laravel', 'backend', ['laravel'], 'php-web'),
  s('.NET', 'backend', ['.net', 'dotnet', 'asp.net', '.net core'], 'dotnet'),
  s('GraphQL', 'backend', ['graphql', 'apollo'], 'api'),
  s('REST APIs', 'backend', ['restful', 'rest api', 'rest apis', 'restful apis', 'rest services'], 'api'),
  s('gRPC', 'backend', ['grpc', 'protobuf', 'protocol buffers'], 'api'),
  s('Microservices', 'backend', ['microservices', 'microservice', 'service-oriented architecture', 'soa']),
  s('Distributed Systems', 'backend', ['distributed systems', 'distributed system']),
  s('System Design', 'backend', ['system design', 'systems design', 'software architecture']),
  s('Kafka', 'backend', ['kafka', 'apache kafka'], 'messaging'),
  s('RabbitMQ', 'backend', ['rabbitmq'], 'messaging'),
  s('Amazon SQS', 'backend', ['sqs', 'amazon sqs'], 'messaging'),
  s('WebSockets', 'backend', ['websocket', 'websockets', 'socket.io']),
  s('OAuth', 'backend', ['oauth', 'oauth2', 'openid connect', 'oidc', 'sso'], 'auth'),

  // Mobile
  s('iOS', 'mobile', ['ios', 'uikit', 'swiftui'], 'apple'),
  s('Android', 'mobile', ['android', 'jetpack compose'], 'android'),
  s('React Native', 'mobile', ['react native', 'react-native'], 'cross-mobile'),
  s('Flutter', 'mobile', ['flutter'], 'cross-mobile'),

  // Data
  s('Pandas', 'data', ['pandas'], 'py-data'),
  s('NumPy', 'data', ['numpy'], 'py-data'),
  s('Apache Spark', 'data', ['spark', 'pyspark', 'apache spark'], 'big-data'),
  s('Hadoop', 'data', ['hadoop', 'hdfs', 'hive'], 'big-data'),
  s('Airflow', 'data', ['airflow', 'apache airflow'], 'orchestration'),
  s('dbt', 'data', ['dbt'], 'transform'),
  s('ETL', 'data', ['etl', 'elt', 'data pipelines', 'data pipeline']),
  s('Data Warehousing', 'data', ['data warehouse', 'data warehousing']),
  s('Snowflake', 'data', ['snowflake'], 'warehouse'),
  s('BigQuery', 'data', ['bigquery'], 'warehouse'),
  s('Redshift', 'data', ['redshift'], 'warehouse'),
  s('Databricks', 'data', ['databricks'], 'big-data'),
  s('Tableau', 'data', ['tableau'], 'bi'),
  s('Power BI', 'data', ['power bi', 'powerbi'], 'bi'),
  s('Looker', 'data', ['looker'], 'bi'),
  s('Excel', 'data', ['microsoft excel', 'ms excel', 'spreadsheets', 'vlookup', 'pivot tables'], undefined, ['Excel']),
  s('Statistics', 'data', ['statistics', 'statistical analysis', 'statistical modeling', 'hypothesis testing']),
  s('A/B Testing', 'data', ['a/b testing', 'ab testing', 'experimentation', 'split testing']),
  s('Data Visualization', 'data', ['data visualization', 'data viz', 'dashboards', 'd3.js', 'd3']),
  s('Data Analysis', 'data', ['data analysis', 'data analytics', 'analytics']),

  // ML / AI
  s('Machine Learning', 'ml', ['machine learning', 'ml'], 'ml'),
  s('Deep Learning', 'ml', ['deep learning', 'neural networks', 'neural network'], 'ml'),
  s('PyTorch', 'ml', ['pytorch', 'torch'], 'ml-framework'),
  s('TensorFlow', 'ml', ['tensorflow', 'keras'], 'ml-framework'),
  s('JAX', 'ml', ['jax'], 'ml-framework'),
  s('scikit-learn', 'ml', ['scikit-learn', 'sklearn', 'scikit learn'], 'ml'),
  s('NLP', 'ml', ['nlp', 'natural language processing'], 'ml'),
  s('Computer Vision', 'ml', ['computer vision', 'opencv', 'image recognition'], 'ml'),
  s('LLMs', 'ml', ['llm', 'llms', 'large language models', 'large language model', 'generative ai', 'genai', 'gpt'], 'genai'),
  s('Prompt Engineering', 'ml', ['prompt engineering'], 'genai'),
  s('RAG', 'ml', ['rag', 'retrieval augmented generation', 'retrieval-augmented generation', 'vector database', 'vector databases', 'embeddings'], 'genai'),
  s('LangChain', 'ml', ['langchain', 'llamaindex'], 'genai'),
  s('MLOps', 'ml', ['mlops', 'mlflow', 'kubeflow', 'model deployment']),
  s('Reinforcement Learning', 'ml', ['reinforcement learning'], 'ml'),
  s('Hugging Face', 'ml', ['hugging face', 'huggingface', 'transformers'], 'genai'),

  // Databases
  s('PostgreSQL', 'database', ['postgresql', 'postgres', 'psql'], 'sql-db'),
  s('MySQL', 'database', ['mysql'], 'sql-db'),
  s('MariaDB', 'database', ['mariadb'], 'sql-db'),
  s('SQL Server', 'database', ['sql server', 'mssql', 't-sql', 'tsql'], 'sql-db'),
  s('Oracle Database', 'database', ['oracle database', 'oracle db', 'pl/sql', 'plsql'], 'sql-db'),
  s('SQLite', 'database', ['sqlite'], 'sql-db'),
  s('MongoDB', 'database', ['mongodb', 'mongo', 'mongoose'], 'nosql'),
  s('DynamoDB', 'database', ['dynamodb'], 'nosql'),
  s('Cassandra', 'database', ['cassandra'], 'nosql'),
  s('Redis', 'database', ['redis'], 'cache'),
  s('Elasticsearch', 'database', ['elasticsearch', 'opensearch', 'elastic search'], 'search'),
  s('Firebase', 'database', ['firebase', 'firestore'], 'nosql'),
  s('Neo4j', 'database', ['neo4j', 'graph database'], 'graph-db'),

  // Cloud
  s('AWS', 'cloud', ['aws', 'amazon web services', 'ec2', 's3', 'lambda', 'cloudwatch'], 'cloud'),
  s('Google Cloud', 'cloud', ['gcp', 'google cloud', 'google cloud platform'], 'cloud'),
  s('Azure', 'cloud', ['azure', 'microsoft azure'], 'cloud'),
  s('Serverless', 'cloud', ['serverless', 'cloud functions', 'aws lambda']),
  s('Cloudflare', 'cloud', ['cloudflare', 'cloudflare workers']),
  s('Vercel', 'cloud', ['vercel', 'netlify']),

  // DevOps
  s('Docker', 'devops', ['docker', 'containers', 'containerization', 'docker compose'], 'containers'),
  s('Kubernetes', 'devops', ['kubernetes', 'k8s', 'helm', 'eks', 'gke', 'aks'], 'orchestration-k8s'),
  s('Terraform', 'devops', ['terraform'], 'iac'),
  s('Pulumi', 'devops', ['pulumi'], 'iac'),
  s('CloudFormation', 'devops', ['cloudformation', 'aws cdk', 'cdk'], 'iac'),
  s('Ansible', 'devops', ['ansible', 'chef', 'puppet'], 'config-mgmt'),
  s('CI/CD', 'devops', ['ci/cd', 'ci cd', 'continuous integration', 'continuous delivery', 'continuous deployment'], 'ci'),
  s('GitHub Actions', 'devops', ['github actions'], 'ci'),
  s('Jenkins', 'devops', ['jenkins'], 'ci'),
  s('GitLab CI', 'devops', ['gitlab ci', 'gitlab-ci'], 'ci'),
  s('CircleCI', 'devops', ['circleci'], 'ci'),
  s('Linux', 'devops', ['linux', 'unix', 'ubuntu', 'debian', 'centos', 'rhel']),
  s('Observability', 'devops', ['observability', 'monitoring', 'prometheus', 'grafana', 'datadog', 'new relic', 'opentelemetry', 'splunk']),
  s('Nginx', 'devops', ['nginx', 'apache httpd', 'load balancing', 'load balancer']),
  s('Networking', 'devops', ['networking', 'tcp/ip', 'dns', 'vpn', 'firewalls', 'routing', 'ccna']),
  s('Site Reliability Engineering', 'devops', ['sre', 'site reliability', 'site reliability engineering', 'on-call', 'incident response']),

  // Testing
  s('Unit Testing', 'testing', ['unit testing', 'unit tests', 'tdd', 'test-driven development', 'test driven development']),
  s('Jest', 'testing', ['jest'], 'js-test'),
  s('Vitest', 'testing', ['vitest'], 'js-test'),
  s('Mocha', 'testing', ['mocha', 'chai'], 'js-test'),
  s('Pytest', 'testing', ['pytest'], 'py-test'),
  s('JUnit', 'testing', ['junit', 'mockito'], 'jvm-test'),
  s('Cypress', 'testing', ['cypress'], 'e2e'),
  s('Playwright', 'testing', ['playwright'], 'e2e'),
  s('Selenium', 'testing', ['selenium', 'webdriver'], 'e2e'),
  s('QA', 'testing', ['quality assurance', 'qa', 'test automation', 'automated testing', 'manual testing']),

  // Security
  s('Application Security', 'security', ['application security', 'appsec', 'owasp', 'secure coding', 'penetration testing', 'pentesting']),
  s('Cybersecurity', 'security', ['cybersecurity', 'cyber security', 'information security', 'infosec', 'siem', 'security operations']),
  s('Identity & Access Management', 'security', ['iam', 'identity and access management', 'rbac', 'active directory', 'ldap'], 'auth'),
  s('Cryptography', 'security', ['cryptography', 'encryption', 'tls', 'pki']),
  s('Compliance', 'security', ['soc 2', 'soc2', 'iso 27001', 'hipaa', 'gdpr', 'pci', 'pci dss', 'fedramp']),

  // Design
  s('Figma', 'design', ['figma'], 'design-tool'),
  s('Sketch', 'design', ['sketch app'], 'design-tool'),
  s('Adobe Creative Suite', 'design', ['photoshop', 'illustrator', 'adobe xd', 'indesign', 'adobe creative suite', 'after effects', 'premiere pro'], 'design-tool'),
  s('UX Design', 'design', ['ux', 'ux design', 'user experience', 'interaction design', 'wireframing', 'prototyping'], 'ux'),
  s('UI Design', 'design', ['ui design', 'visual design', 'design systems', 'design system'], 'ux'),
  s('User Research', 'design', ['user research', 'usability testing', 'user interviews'], 'ux'),

  // Product / business
  s('Product Management', 'product', ['product management', 'product manager', 'product strategy', 'product roadmap']),
  s('Agile', 'practice', ['agile', 'scrum', 'kanban', 'sprint planning']),
  s('Project Management', 'business', ['project management', 'pmp', 'program management']),
  s('Stakeholder Management', 'soft', ['stakeholder management', 'stakeholders', 'cross-functional', 'cross functional']),
  s('SEO', 'business', ['seo', 'search engine optimization'], 'marketing'),
  s('SEM', 'business', ['sem', 'google ads', 'paid search', 'ppc'], 'marketing'),
  s('Google Analytics', 'business', ['google analytics', 'ga4'], 'analytics-tool'),
  s('Salesforce', 'business', ['salesforce', 'sfdc'], 'crm'),
  s('HubSpot', 'business', ['hubspot'], 'crm'),
  s('Content Marketing', 'business', ['content marketing', 'copywriting', 'content strategy'], 'marketing'),
  s('Financial Modeling', 'business', ['financial modeling', 'financial modelling', 'valuation', 'dcf']),
  s('Accounting', 'business', ['accounting', 'gaap', 'ifrs', 'bookkeeping', 'quickbooks']),
  s('Sales', 'business', ['sales experience', 'b2b sales', 'business development', 'account management', 'lead generation', 'quota attainment']),
  s('Customer Success', 'business', ['customer success', 'customer support', 'customer service']),
  s('ERP', 'business', ['erp', 'sap', 'netsuite', 'oracle erp']),

  // Tools
  s('Git', 'tool', ['git', 'github', 'gitlab', 'bitbucket', 'version control']),
  s('Jira', 'tool', ['jira', 'confluence'], 'pm-tool'),
  s('Linear', 'tool', ['linear app', 'linear.app'], 'pm-tool'),
  s('Postman', 'tool', ['postman']),
  s('Unity', 'tool', ['unity3d', 'unity engine'], 'game-engine', ['Unity']),
  s('Unreal Engine', 'tool', ['unreal', 'unreal engine'], 'game-engine'),

  // Practices
  s('Code Review', 'practice', ['code review', 'code reviews']),
  s('Object-Oriented Programming', 'practice', ['object-oriented', 'object oriented', 'oop', 'design patterns']),
  s('Functional Programming', 'practice', ['functional programming']),
  s('Data Structures & Algorithms', 'practice', ['data structures', 'algorithms', 'dsa']),
  s('Performance Optimization', 'practice', ['performance optimization', 'performance tuning', 'profiling', 'optimization']),
  s('Embedded Systems', 'practice', ['embedded systems', 'embedded software', 'firmware', 'rtos', 'microcontrollers', 'arduino']),
  s('Technical Writing', 'practice', ['technical writing', 'documentation']),

  // Soft skills
  s('Communication', 'soft', ['communication skills', 'communication', 'written and verbal', 'verbal communication', 'written communication']),
  s('Leadership', 'soft', ['leadership', 'team lead', 'led a team', 'people management']),
  s('Mentoring', 'soft', ['mentoring', 'mentorship', 'coaching', 'mentor']),
  s('Problem Solving', 'soft', ['problem solving', 'problem-solving', 'analytical skills', 'critical thinking']),
  s('Collaboration', 'soft', ['collaboration', 'teamwork', 'collaborative']),
];

export const SKILL_BY_NAME = new Map(SKILLS.map((d) => [d.name.toLowerCase(), d]));

export function findSkillDef(name: string): SkillDef | undefined {
  const key = name.trim().toLowerCase();
  const direct = SKILL_BY_NAME.get(key);
  if (direct) return direct;
  return SKILLS.find((d) => d.aliases?.includes(key) || d.exact?.some((e) => e.toLowerCase() === key));
}
