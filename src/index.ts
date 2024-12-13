import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

console.log("Starting...");

dotenv.config();

// GitHub credentials
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN;
const GITHUB_ORGANIZATION_NAME = process.env.GITHUB_ORGANIZATION_NAME;

// Statistics parameters
const STATISTICS_SINCE_TIMESTAMP = process.env.STATISTICS_SINCE_TIMESTAMP;

const githubRequestsInterval = 10;
const githubRequestsMax = 100;
let githubRequestsPending = 0;
const statisticsOutputFile = "./out/github_organization_statistics.txt";

// Axios settings
axios.defaults.baseURL = "https://api.github.com";
axios.defaults.headers.common.Authorization = `token ${GITHUB_ACCESS_TOKEN}`;

axios.interceptors.request.use(function (config) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (githubRequestsPending < githubRequestsMax) {
        githubRequestsPending++;
        clearInterval(interval);
        resolve(config);
      }
    }, githubRequestsInterval);
  });
});

axios.interceptors.response.use(function(response) {
    githubRequestsPending = Math.max(0, githubRequestsPending - 1);
  return Promise.resolve(response);
}, function(error) {
    githubRequestsPending = Math.max(0, githubRequestsPending - 1);
  return Promise.reject(error);
});

async function paged(url, config?, page = 1) {
  const { data } = await axios.get(url, { params: { ...(config?.params || {}), per_page: 100, page: page } });
  if (data.length > 0) {
    data.push(...await paged(url, config, page + 1));
  }
  return data;
}

async function getAllRepos() {
  const data = await paged(`/orgs/${GITHUB_ORGANIZATION_NAME}/repos`);
  return data.map(repo => repo.name);
}

async function getPull(repo, pullNumber) {
  const { data } = await axios.get(`/repos/${GITHUB_ORGANIZATION_NAME}/${repo}/pulls/${pullNumber}`);
  return data;
}

function matchFilters(pull, filters) {
  if (filters.since && pull.created_at < filters.since) {
    return false;
  }
  if (filters.label && !pull.labels.some(label => label.name === filters.label)) {
    return false;
  }
  return true;
}

async function getPulls(repo, filters) {
  const data = await paged(`/repos/${GITHUB_ORGANIZATION_NAME}/${repo}/pulls`, { params: { state: 'all' } });
  console.log(data);
  return await Promise.all(data.filter(pull => matchFilters(pull, filters))
    .map(async pull => {
      const { additions, deletions, commits } = await getPull(repo, pull.number);
      return {
        number: pull.number,
        additions,
        deletions,
        commits
      };
    }));
}

async function showRateLimit() {
  const { data } = await axios.get('/rate_limit');
  console.log(data);
  console.log('Access quota will be reset at:', new Date(data.rate.reset * 1000));
}

function sumBy(array, key) {
  return array.reduce((acc, obj) => acc + obj[key], 0);
}

function getFinishedRepos() {
  if (!fs.existsSync(statisticsOutputFile)) {
    return [];
  }
  const file = fs.readFileSync(statisticsOutputFile, 'utf8');
  const lines = file.split('\n').slice(1);
  return lines.map(line => line.split('\t')[0]);
}

async function main() {
    await showRateLimit();

    try {
        const allRepos = await getAllRepos();
        const finishedRepos = getFinishedRepos();
        const leftRepos = allRepos.filter(repo => !finishedRepos.includes(repo));
        console.log(`Found ${allRepos.length} repos, ${leftRepos.length} left`);
        console.log('repo\t#pulls\t#commits\t#additions\t#deletions');
        await leftRepos.forEach(async repo => {
          const pulls = await getPulls(repo, { since: STATISTICS_SINCE_TIMESTAMP });
          const numberOfPulls = pulls.length;
          const numberOfCommits = sumBy(pulls, 'commits');
          const numberOfAdditions = sumBy(pulls, 'additions');
          const numberOfDeletions = sumBy(pulls, 'deletions');
          const line = `${repo}\t${numberOfPulls}\t${numberOfCommits}\t${numberOfAdditions}\t${numberOfDeletions}`;
          console.log(line);
          fs.appendFileSync(statisticsOutputFile, line + '\n', 'utf-8');
        });
      } catch (e) {
        console.log(e.message);
        console.log(e?.response?.data);
      }
      
      console.log(`See ${statisticsOutputFile} for result.`);
}

main();
