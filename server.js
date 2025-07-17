require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const nodemailer = require('nodemailer');
const userAgents = require('user-agents');
const { URLSearchParams } = require('url');
const { pool, initializeDatabase } = require('./db');
const fs = require('fs');
const path = require('path');
// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const isProduction = process.env.NODE_ENV === 'production';

// Configure Chromium for production
// chromium.setGraphicsMode = false; // Disable GPU in production

const getBrowser = async () => {
  const launchOptions = {
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    headless: isProduction ? chromium.headless : false,
    defaultViewport: chromium.defaultViewport,
    ignoreHTTPSErrors: true,
    executablePath: isProduction ? await chromium.executablePath() : undefined
  };

  return puppeteer.launch(launchOptions);
};

// Database functions
async function readJobs(filters = {}) {
  try {
    let query = 'SELECT * FROM jobs';
    const queryParams = [];
    const whereClauses = [];
    
    if (filters.role) {
      queryParams.push(`%${filters.role}%`);
      whereClauses.push(`title ILIKE $${queryParams.length}`);
    }
    
    if (filters.location) {
      queryParams.push(`%${filters.location}%`);
      whereClauses.push(`location ILIKE $${queryParams.length}`);
    }
    
    if (filters.source) {
      queryParams.push(`%${filters.source}%`);
      whereClauses.push(`source ILIKE $${queryParams.length}`);
    }
    
    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }
    
    query += ' ORDER BY posted_date DESC';
    
    const result = await pool.query(query, queryParams);
    return result.rows;
  } catch (error) {
    console.error('Error reading jobs:', error);
    return [];
  }
}
async function saveJobs(jobs) {
  if (!jobs || jobs.length === 0) return { newJobs: 0, duplicates: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = await Promise.allSettled(
      jobs.map(job => client.query(
        `INSERT INTO jobs 
        (title, company, experience, location, skills, salary, link, source, posted_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (link) DO NOTHING`,
        [
          job.title,
          job.company,
          job.experience || 'N/A',
          job.location || 'N/A',
          job.skills || [],
          job.salary || 'Not specified',
          job.link,
          job.source || 'Unknown',
          job.postedDate || new Date()
        ]
      ))
    );

    const newJobs = results.filter(r => r.status === 'fulfilled' && r.value.rowCount === 1).length;
    const duplicates = jobs.length - newJobs;

    await client.query('COMMIT');
    
    console.log(`Saved ${newJobs} new jobs, found ${duplicates} duplicates`);
    return { newJobs, duplicates };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving jobs:', error);
    return { newJobs: 0, duplicates: 0 };
  } finally {
    client.release();
  }
}
// Utility functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

// Utility functions

async function crawlNaukri(role, location, experience = '') {
    let browser;
    try {
        console.log(`Scraping Naukri for ${role} in ${location}...`);
            browser = await getBrowser();

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Build the initial URL
        const baseUrl = `https://www.naukri.com/${role.toLowerCase().replace(/\s+/g, '-')}-jobs-in-${location.toLowerCase().replace(/\s+/g, '-')}`;
        let url = baseUrl;

        // Add experience filter if specified
        if (experience) {
            url += `?experience=${experience}`;
        }

        console.log(`Navigating to: ${url}`);
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Handle popups
        try {
            await page.click('span[class*="crossIcon"]', { timeout: 5000 });
            console.log('Closed popup');
        } catch (e) {
            console.log('No popup found');
        }

        // Function to extract jobs from current page
        const extractJobs = async () => {
            return await page.evaluate(() => {
                const jobElements = Array.from(document.querySelectorAll('.srp-jobtuple-wrapper'));
                return jobElements.map(job => {
                    const title = job.querySelector('.title')?.textContent?.trim() || 'N/A';
                    const company = job.querySelector('.comp-name')?.textContent?.trim() || 'N/A';
                    const experience = job.querySelector('.expwdth')?.textContent?.trim() || 'N/A';
                    const location = job.querySelector('.locWdth')?.textContent?.trim() || 'N/A';
                    const skills = Array.from(job.querySelectorAll('.tags-gt li')).map(li => li.textContent.trim());
                    const link = job.querySelector('a.title')?.href || '#';

                    return { title, company, experience, location, skills, link };
                });
            });
        };

        let allJobs = [];
        let currentPage = 1;
        const maxPages = 10; // Limit to prevent infinite scraping

        while (currentPage <= maxPages) {
            console.log(`Scraping page ${currentPage}...`);

            // Wait for jobs to load
            await page.waitForSelector('.srp-jobtuple-wrapper', { timeout: 30000 });

            // Extract jobs from current page
            const pageJobs = await extractJobs();
            allJobs = [...allJobs, ...pageJobs];
            console.log(`Found ${pageJobs.length} jobs on page ${currentPage}`);

            // Try to go to next page
            try {
                const nextPageUrl = `${baseUrl}-${currentPage + 1}${experience ? `?experience=${experience}` : ''}`;
                await page.goto(nextPageUrl, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });
                currentPage++;
            } catch (e) {
                console.log(`No more pages found after page ${currentPage}`);
                break;
            }
        }

        console.log(`Total jobs found: ${allJobs.length}`);

        // Save to JSON
        // const dir = './data';
        // if (!fs.existsSync(dir)) {
        //     fs.mkdirSync(dir);
        // }
        // fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(allJobs, null, 2));

        return allJobs;
    } catch (error) {
        console.error('Scraping failed:', error);
        throw error;
    } finally {
        if (browser) {  // Add this check
            await browser.close();
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}


async function crawlShine(role, location, experience = '', maxPages = 5) {
    let browser;
    try {
        console.log(`Scraping Shine for ${role} in ${location}...`);
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(new userAgents({ deviceCategory: 'desktop' }).toString());
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Build base URL
        const searchQuery = role.toLowerCase().replace(/\s+/g, '-');
        const locationQuery = location.toLowerCase().replace(/\s+/g, '-');
        let baseUrl = `https://www.shine.com/job-search/${searchQuery}-jobs-in-${locationQuery}`;
        if (experience) baseUrl += `?exp=${experience}`;

        let allJobs = [];
        let currentPage = 1;

        while (currentPage <= maxPages) {
            let url = baseUrl;
            if (currentPage > 1) {
                url += `&page=${currentPage}`;
            }

            console.log(`Navigating to page ${currentPage}: ${url}`);
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // Debug: Take screenshot
            await page.screenshot({ path: `shine-page-${currentPage}.png` });
            console.log(`Took screenshot: shine-page-${currentPage}.png`);

            // Wait for either jobs to load or "no jobs" message
            try {
                await Promise.race([
                    page.waitForSelector('.jdbigCard.jobCardNova_bigCard__W2xn3', { timeout: 15000 }),
                    page.waitForSelector('.noJobFoundContainer__noJobFoundWrapper__9Hv0O', { timeout: 15000 })
                ]);
            } catch (e) {
                console.log('Neither jobs nor "no jobs" message found within timeout');
            }

            // Check if "no jobs" message exists
            const noJobsFound = await page.$('.noJobFoundContainer__noJobFoundWrapper__9Hv0O');
            if (noJobsFound) {
                console.log('No more jobs found');
                break;
            }

            // Scroll to load more jobs (if lazy-loaded)
            await autoScroll(page);

            // Extract jobs from current page
            const pageJobs = await extractShineJobs(page);
            if (pageJobs.length === 0) {
                console.log('No jobs found on this page');
                break;
            }

            allJobs = [...allJobs, ...pageJobs];
            console.log(`Found ${pageJobs.length} jobs on page ${currentPage}`);

            currentPage++;
        }

        console.log(`Total jobs found from Shine: ${allJobs.length}`);
        return allJobs;
    } catch (error) {
        console.error('Shine scraping failed:', error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Separate function for job extraction
async function extractShineJobs(page) {
    return await page.evaluate(() => {
        const jobElements = Array.from(document.querySelectorAll('.jdbigCard.jobCardNova_bigCard__W2xn3'));
        return jobElements.map(job => {
            try {
                const titleElem = job.querySelector('.jobCardNova_bigCardTopTitleHeading__Rj2sC a');
                const title = titleElem?.textContent?.trim() || 'N/A';
                const link = titleElem?.href || '#';

                const companyElem = job.querySelector('.jobCardNova_bigCardTopTitle__vLLav + span') || 
                                    job.querySelector('.jobCardNova_bigCardTopTitle__vLLav span');
                const company = companyElem?.textContent?.trim() || 'N/A';

                const detailSpans = job.querySelectorAll('.jobCardNova_bigCardBottom__uVExC span');
                let experience = 'N/A';
                let location = 'N/A';
                let salary = 'Not specified';

                if (detailSpans.length >= 3) {
                    experience = detailSpans[0]?.textContent?.trim() || 'N/A';
                    location = detailSpans[1]?.textContent?.trim() || 'N/A';
                    salary = detailSpans[2]?.textContent?.trim() || 'Not specified';
                }

                return {
                    title,
                    company,
                    experience,
                    location,
                    salary,
                    link,
                    source: 'Shine',
                    postedDate: new Date().toISOString()
                };
            } catch (err) {
                console.error('Error extracting job:', err);
                return null;
            }
        }).filter(Boolean);
    });
}

// Auto-scroll function
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 200);
        });
    });
}

async function crawlHirist(role, location, minExp = '', maxExp = '') {
    let browser;
    try {
        console.log(`Scraping Hirist.tech for ${role} in ${location}...`);
        browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Build the URL with query parameters
        const searchQuery = role.toLowerCase().replace(/\s+/g, '-');
        let url = `https://www.hirist.tech/search/${searchQuery}?loc=${encodeURIComponent(location)}`;
        
        if (minExp) url += `&minexp=${minExp}`;
        if (maxExp) url += `&maxexp=${maxExp}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Function to extract jobs from current page
        const extractJobs = async () => {
            return await page.evaluate(() => {
                const jobElements = Array.from(document.querySelectorAll('.MuiBox-root.mui-style-1ancegk'));
                return jobElements.map(job => {
                    const titleElement = job.querySelector('[data-testid="job_title"]');
                    const title = titleElement?.textContent?.trim() || 'N/A';
                    const link = titleElement?.closest('a')?.href || '#';

                    const company = job.querySelector('.MuiTypography-subtitle1')?.textContent?.trim() || 'N/A';
                    
                    const experienceElement = job.querySelector('[data-testid="job_experience"]');
                    const experience = experienceElement?.textContent?.trim() || 'N/A';
                    
                    const location = job.querySelector('[data-testid="job_location"]')?.textContent?.trim() || 'N/A';
                    
                    const salary = job.querySelector('.MuiTypography-root.mui-style-1n4cg6k')?.textContent?.trim() || 'Not specified';
                    
                    // Extract skills if available
                    const skillsElement = job.querySelector('.MuiBox-root.mui-style-1u0q1tk');
                    const skills = skillsElement ? 
                        Array.from(skillsElement.querySelectorAll('span')).map(span => span.textContent.trim()) : [];

                    return { 
                        title, 
                        company, 
                        experience, 
                        location, 
                        skills, 
                        salary,
                        link,
                        source: 'Hirist.tech',
                        postedDate: new Date().toISOString()
                    };
                });
            });
        };

        let allJobs = [];
        let currentPage = 1;
        const maxPages = 10;

        while (currentPage <= maxPages) {
            console.log(`Scraping page ${currentPage}...`);

            // Wait for jobs to load
            try {
                await page.waitForSelector('.MuiBox-root.mui-style-1ancegk', { timeout: 30000 });
            } catch (e) {
                console.log('No jobs found on page', currentPage);
                break;
            }

            // Scroll to load more jobs
            await autoScroll(page);

            // Extract jobs from current page
            const pageJobs = await extractJobs();
            if (pageJobs.length === 0) break;
            
            allJobs = [...allJobs, ...pageJobs];
            console.log(`Found ${pageJobs.length} jobs on page ${currentPage}`);

            // Try to go to next page
            try {
                const nextButton = await page.$('button[aria-label="Go to next page"]');
                if (nextButton && !await nextButton.evaluate(btn => btn.disabled)) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
                        nextButton.click()
                    ]);
                    currentPage++;
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Replaced waitForTimeout
                } else {
                    console.log('No more pages available');
                    break;
                }
            } catch (e) {
                console.log(`Failed to navigate to next page: ${e.message}`);
                break;
            }
        }

        console.log(`Total jobs found from Hirist.tech: ${allJobs.length}`);
        return allJobs;
    } catch (error) {
        console.error('Hirist.tech scraping failed:', error);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

// Updated autoScroll function without waitForTimeout
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
    // Replace waitForTimeout with traditional setTimeout
    await new Promise(resolve => setTimeout(resolve, 1000));
}
// Email functions
async function sendEmailAlert(email, jobs) {
  try {
    if (!jobs || jobs.length === 0) {
      console.log('No jobs to email');
      return false;
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: `"Job Crawler" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `New Job Alerts (${jobs.length} positions)`,
      html: generateEmailHtml(jobs)
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Email sending failed:', error.message);
    return false;
  }
}

function generateEmailHtml(jobs) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
      <h1 style="color: #333;">New Job Matches</h1>
      <ul style="list-style: none; padding: 0;">
        ${jobs.map(job => `
          <li style="margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
            <h3 style="margin: 0 0 5px 0; color: #1976d2;">${job.title}</h3>
            <p style="margin: 0 0 5px 0;"><strong>Company:</strong> ${job.company}</p>
            <p style="margin: 0 0 5px 0;"><strong>Location:</strong> ${job.location}</p>
            ${job.salary !== 'Not specified' ? `<p style="margin: 0 0 5px 0;"><strong>Salary:</strong> ${job.salary}</p>` : ''}
            <p style="margin: 0 0 5px 0;"><strong>Posted:</strong> ${new Date(job.posted_date).toLocaleDateString()}</p>
            <p style="margin: 0 0 5px 0;"><strong>Source:</strong> ${job.source}</p>
            <a href="${job.link}" style="display: inline-block; margin-top: 10px; padding: 8px 15px; background-color: #1976d2; color: white; text-decoration: none; border-radius: 4px;">View Job</a>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

// API Routes
app.post('/api/crawl', async (req, res) => {
  try {
    const { role, location, source = 'naukri', experience } = req.body;

    if (!role || !location) {
      return res.status(400).json({
        success: false,
        error: 'Role and location are required'
      });
    }

    let jobs = [];
    const startTime = Date.now();

    switch (source.toLowerCase()) {
      case 'naukri':
        console.log(`Starting Naukri crawl for ${role} in ${location}`);
        jobs = await crawlNaukri(role, location, experience);
        break;

      case 'shine':
        console.log(`Starting Shine crawl for ${role} in ${location}`);
        jobs = await crawlShine(role, location);
        break;
      
      case 'hirist':
        console.log(`Starting Hirist crawl for ${role} in ${location}`);
        jobs = await crawlHirist(role, location);
        break;

      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid source. Supported sources are "naukri", "shine", and "hirist".'
        });
    }

    // Save to database
     const { newJobs, duplicates } = await saveJobs(jobs);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

   res.json({
      success: true,
      source,
      role,
      location,
      totalJobs: jobs.length,
      newJobs,       // Use the returned count
      duplicates,    // Use the returned count
      duration: `${duration} seconds`,
      jobs: jobs.slice(0, 50)
    });

  } catch (error) {
    console.error('Crawl error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const { role, location, source, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    // Build the query dynamically based on filters
    let query = 'SELECT * FROM jobs';
    const queryParams = [];
    const whereClauses = [];
    
    if (role) {
      queryParams.push(`%${role}%`);
      whereClauses.push(`title ILIKE $${queryParams.length}`);
    }
    
    if (location) {
      queryParams.push(`%${location}%`);
      whereClauses.push(`location ILIKE $${queryParams.length}`);
    }
    
    if (source) {
      queryParams.push(`%${source}%`);
      whereClauses.push(`source ILIKE $${queryParams.length}`);
    }
    
    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }
    
    // Add pagination
    query += ` ORDER BY posted_date DESC LIMIT ${limit} OFFSET ${offset}`;
    
    // Get jobs
    const jobsResult = await pool.query(query, queryParams);
    const jobs = jobsResult.rows;
    
    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) FROM jobs';
    if (whereClauses.length > 0) {
      countQuery += ' WHERE ' + whereClauses.join(' AND ');
    }
    const countResult = await pool.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);
    
    res.json({
      success: true,
      count: jobs.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      jobs
    });
  } catch (error) {
    console.error('Jobs fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alert', async (req, res) => {
  try {
    const { email, role, location, source } = req.body;
    if (!email || !role) {
      return res.status(400).json({
        success: false,
        error: 'Email and role are required'
      });
    }

    // Build query for jobs from last 24 hours
    let query = `
      SELECT * FROM jobs 
      WHERE posted_date >= NOW() - INTERVAL '24 HOURS'
      AND title ILIKE $1
    `;
    const queryParams = [`%${role}%`];
    
    if (location) {
      queryParams.push(`%${location}%`);
      query += ` AND location ILIKE $${queryParams.length}`;
    }
    
    if (source) {
      queryParams.push(`%${source}%`);
      query += ` AND source ILIKE $${queryParams.length}`;
    }
    
    query += ' ORDER BY posted_date DESC LIMIT 10';
    
    const result = await pool.query(query, queryParams);
    const jobs = result.rows;

    if (jobs.length === 0) {
      return res.json({
        success: true,
        sent: 0,
        message: 'No matching jobs found to send'
      });
    }

    const emailResult = await sendEmailAlert(email, jobs);

    if (!emailResult) {
      return res.status(500).json({
        success: false,
        error: 'Failed to send email'
      });
    }

    res.json({
      success: true,
      sent: jobs.length,
      message: `Alert sent with ${jobs.length} jobs`
    });
  } catch (error) {
    console.error('Alert error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbResult = await pool.query('SELECT COUNT(*) FROM jobs');
    const jobCount = parseInt(dbResult.rows[0].count);
    
    res.json({
      status: 'OK',
      storage: 'PostgreSQL (Neon)',
      jobCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});
app.get('/api/verify-db', async (req, res) => {
  try {
    // Check connection
    await pool.query('SELECT 1');
    
    // Check table exists
    const tableExists = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'jobs')"
    );
    
    // Check row count
    const countResult = await pool.query('SELECT COUNT(*) FROM jobs');
    const jobCount = parseInt(countResult.rows[0].count);
    
    // Check unique constraint
    const constraints = await pool.query(`
      SELECT conname FROM pg_constraint 
      WHERE conrelid = 'jobs'::regclass AND contype = 'u'
    `);

    res.json({
      connected: true,
      tableExists: tableExists.rows[0].exists,
      jobCount,
      hasUniqueConstraint: constraints.rows.length > 0,
      constraints: constraints.rows
    });
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: error.message
    });
  }
});
// Initialize database and start server
initializeDatabase().then(() => {
  const PORT = process.env.PORT || 5000;
  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Jobs stored in PostgreSQL (Neon)`);
  });

  // Handle shutdown gracefully
  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});