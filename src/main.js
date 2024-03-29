import fs from "fs";
import ncp from "ncp";
import path from "path";
import os from "os"
import { promisify } from "util";
import { execSync } from "child_process";
import { fileURLToPath } from 'url';
import crypto from "crypto";
import { addEndpointToDynamo, getLBEndpoint, createS3 } from "./awsHelpers.js"

const access = promisify(fs.access);
const copy = promisify(ncp);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const homeDir = os.homedir();
const appDir = path.join(homeDir, "snowclone");

async function copyTemplateFiles(options) {
  return copy(options.templateDirectory, options.targetDirectory, {
    clobber: false,
  });
}

// save bucket name to users home directory in snowclone folder
function saveS3Info(bucketName) {
  const data = {bucketName}
  fs.mkdirSync(appDir, { recursive: true });
  const fileName = path.join(appDir, "S3.json")

  fs.writeFile(fileName, JSON.stringify(data), (err) => {
    if (err) {
      console.error(err);
    }
  })
}

// get info from file we saved
function getS3Info() {
  const s3File = path.join(appDir, "S3.json")
  const data = fs.readFileSync(s3File, "utf8")
  return JSON.parse(data).bucketName;
}

// create S3 bucket, create admin infra and save state to the bucket. (deal w/ configs, change to try/ catch block later)
export async function initializeAdmin(configs) {
  const s3BucketName = "snowclone-" + crypto.randomBytes(6).toString("hex");
  const s3Bucket = await createS3(s3BucketName);
  const terraformAdminDir = path.join(__dirname, "terraform", "admin");
  execSync(`terraform init -reconfigure \
  -backend-config="bucket=${s3BucketName}" \
  -backend-config="region=us-west-2" \
  -backend-config="key=admin/terraform.tfstate"`, { cwd: terraformAdminDir});
  console.log("Initialized admin!");
  execSync(`terraform apply -auto-approve`, { cwd: terraformAdminDir });
  console.log("Admin stack applied!")
  saveS3Info(s3BucketName);
}

// provision backend, save endpoint to dynamo
export  async function deployProject(configs) {
  const terraformMainDir = path.join(__dirname, "terraform");
  const s3BucketName = getS3Info();
  console.log("S3 name: ", s3BucketName); 

  try {
    execSync(`terraform init -migrate-state \
            -backend-config="bucket=${s3BucketName}" \
            -backend-config="region=us-west-2" \
            -backend-config="key=${configs.name}/terraform.tfstate"`, { cwd: terraformMainDir});
    console.log("Initialized!");
    execSync(`terraform apply -auto-approve`, { encoding: "utf-8", cwd: terraformMainDir});
    console.log("Stack has been deployed!");
    const tfOutputs = execSync("terraform output -json", { cwd: terraformMainDir }).toString();
    const projectEndpoint = JSON.parse(tfOutputs).app_url.value;
    addEndpointToDynamo(configs.name, projectEndpoint);
  } catch (error) {
    console.error('Error executing Terraform apply:', error.message);
    process.exit(1);
  }
}


export async function uploadSchema(schemaFile, projectName) {
  const LBEndpoint = await getLBEndpoint(projectName);
  execSync(`curl -F 'file=@${schemaFile}' ${LBEndpoint}/schema`);
}

// creates a new directory in .
export async function createProject(options) {
  options = {
    ...options,
    targetDirectory: options.name
      ? path.join(process.cwd(), options.name)
      : process.cwd(),
  }; 

  const currentFileUrl = import.meta.url;
  const templateDir = path.resolve(
    new URL(currentFileUrl).pathname,
    "../../relay-instance-template"
  );
  options.templateDirectory = templateDir;

  try {
    await access(templateDir, fs.constants.R_OK);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  console.log("Copy project files");
  await copyTemplateFiles(options);

  console.log("Project ready");
  return true;
}
