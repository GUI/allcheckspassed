import * as core from '@actions/core';
import {IInputs} from '../utils/inputsExtractor';
import {getAllChecks} from './checksAPI';
import {ICheckInput, ICheck, IStatus} from './checksInterfaces';
import {
    checkOneOfTheChecksInputIsEmpty, filterChecksByConclusion, filterChecksByStatus,
    filterChecksWithMatchingNameAndAppId,
    removeChecksWithMatchingNameAndAppId,
    removeDuplicateChecksEntriesFromSelf,
    removeDuplicateEntriesChecksInputsFromSelf
} from './checksFilters';
import {sleep} from "../utils/timeFuncs";
import {extractOwnCheckNameFromWorkflow} from "../utils/fileExtractor";
import {checkConclusion, checkStatus, GitHubActionsBotId} from "./checksConstants";


interface IRepo {
    owner: string;
    repo: string;
}

export default class Checks {
    // data
    private allChecks: ICheck[] = [];
    private filteredChecks: ICheck[] = [];
    private allChecksPassed: boolean = false;
    private missingChecks: ICheckInput[] = [];
    private ownCheck: ICheck | undefined; //the check from the workflow run itself

    // inputs
    private owner: string;
    private repo: string;
    private ref: string;
    private checksExclude: ICheckInput[];
    private checksInclude: ICheckInput[];
    private treatSkippedAsPassed: boolean;
    private treatNeutralAsPassed: boolean;
    private failOnMissingChecks: boolean;
    private poll: boolean;
    private retries: number;
    private pollingInterval: number;


    constructor(props: IRepo & IInputs) {
        this.owner = props.owner;
        this.repo = props.repo;
        this.ref = props.commitSHA;
        this.checksExclude = props.checksExclude;
        this.checksInclude = props.checksInclude;
        this.treatSkippedAsPassed = props.treatSkippedAsPassed;
        this.treatNeutralAsPassed = props.treatNeutralAsPassed;
        this.failOnMissingChecks = props.failOnMissingChecks;
        this.poll = props.poll;
        this.pollingInterval = props.pollingInterval;
        this.retries = props.retries;

    }

    async fetchAllChecks() {
        try {
            this.allChecks = await getAllChecks(this.owner, this.repo, this.ref) as ICheck[];
        } catch (error: any) {
            throw new Error("Error getting all checks: " + error.message);
        }
    }

    async filterChecks() {

        // lets get the check from the workflow run itself, if the value already exists, don't re-fetch it

        if (!this.ownCheck) {
            let ownCheckName = await extractOwnCheckNameFromWorkflow();
            let gitHubActionsBotId = GitHubActionsBotId;

            this.ownCheck = this.allChecks.find(check => check.name === ownCheckName && check.app.id === gitHubActionsBotId);
        }


        // start by checking if the user has defined both checks_include and checks_exclude inputs and fail if that is the case
        let ambigousChecks = checkOneOfTheChecksInputIsEmpty(this.checksInclude, this.checksExclude);
        if (!ambigousChecks) {
            throw new Error("You cannot define both checks_include and checks_exclude inputs, please use only one of them");
        }
        // if neither checks_include nor checks_exclude are defined, then we will use all checks

        if (this.checksInclude.length === 0 && this.checksExclude.length === 0) {
            this.filteredChecks = [...this.allChecks];
            return;
        }

        // if only checks_include is defined, then we will use only the checks that are included
        if (this.checksInclude.length > 0 && this.checksExclude.length === 0) {
            let firstPassthrough = filterChecksWithMatchingNameAndAppId(this.allChecks, this.checksInclude);
            // lets separate the object

            let filteredChecks = firstPassthrough["filteredChecks"];
            let missingChecks = firstPassthrough["missingChecks"];

            this.filteredChecks = removeDuplicateChecksEntriesFromSelf(filteredChecks);
            this.missingChecks = removeDuplicateEntriesChecksInputsFromSelf(missingChecks);
            return;
        }

        if (this.checksExclude.length > 0 && this.checksInclude.length === 0) {
            let firstPassthrough = removeChecksWithMatchingNameAndAppId(this.allChecks, this.checksExclude);
            this.filteredChecks = removeDuplicateChecksEntriesFromSelf(firstPassthrough);
            return;
        }


    };

    determineChecksFailure(checks: ICheck[]): boolean {
        // if any of the checks are still in_progress or queued or waiting, then we will return false
        let inProgressQueuedWaiting = [checkStatus.IN_PROGRESS, checkStatus.QUEUED, checkStatus.WAITING]
        let anyInProgressQueuedWaiting = checks.filter(check => inProgressQueuedWaiting.includes(check.status));
        if (anyInProgressQueuedWaiting.length > 0) {
            return false;
        }
        // conclusions that determine a fail
        let failureConclusions: string[] = [checkConclusion.FAILURE, checkConclusion.TIMED_OUT, checkConclusion.CANCELLED, checkConclusion.ACTION_REQUIRED, checkConclusion.STALE];
        // if the user wanted us to treat skipped as a failure, then we will add it to the failureConclusions array
        if (!this.treatSkippedAsPassed) {
            failureConclusions.push(checkConclusion.SKIPPED);
        }

        // if the user wanted us to treat neutral as a failure, then we will add it to the failureConclusions array
        if (!this.treatNeutralAsPassed) {
            failureConclusions.push(checkConclusion.NEUTRAL);
        }

        // if any of the checks are failing, then we will return true
        let failingChecks = checks.filter(check => failureConclusions.includes(check.conclusion!));

        if (failingChecks.length > 0) {
            return false;
        }

        return true;

    };

    async iterate() {
        await this.fetchAllChecks();
        await this.filterChecks();

        // check for any in_progess checks in the filtered checks excluding the check from the workflow run itself

        let filteredChecksExcludingOwnCheck = this.filteredChecks.filter(check => check.id !== this.ownCheck?.id);
        let allChecksPass = this.determineChecksFailure(filteredChecksExcludingOwnCheck);
        this.allChecksPassed = allChecksPass;
        return {
            allChecksPass, missingChecks: this.missingChecks, filteredChecksExcludingOwnCheck
        }

    }

    async run() {
        let iteration = 0;
        let allChecksPass = false;
        let missingChecks: ICheckInput[] = [];
        let filteredChecksExcludingOwnCheck: ICheck[] = [];

        do {
            iteration++;
            let result = await this.iterate();
            allChecksPass = result["allChecksPass"];
            missingChecks = result["missingChecks"];
            filteredChecksExcludingOwnCheck = result["filteredChecksExcludingOwnCheck"];

            //check if the user wants us to poll
            if (!this.poll) {
                break;
            }
            if (allChecksPass) {
                break;
            }
            await sleep(this.pollingInterval * 1000 * 60);
        } while (iteration < this.retries);

        // create table with results of filtered checks

        let checkSummaryHeader = [{data: 'name', header: true}, {data: 'status', header: true}, {
            data: 'conclusion',
            header: true
        }, {data: 'started_at', header: true}, {data: 'completed_at', header: true}, {
            data: 'app.name',
            header: true
        }, {data: 'app.id', header: true}];

        let checkSummary: any[] = filteredChecksExcludingOwnCheck.map(check => {
            return [check.name, check.status, check.conclusion ? check.conclusion : " ", check.started_at, check.completed_at ? check.completed_at : " ", check.app.name, check.app.id.toString()]
        });


        await core.summary.addHeading("Checks Summary").addTable([

            checkSummaryHeader,
            ...checkSummary

        ]).write();

        // fail the step if the checks did not pass
        if (!allChecksPass) {
            core.setFailed("Some checks have failed or timed out, please check the workflow run summary to get the details");
        }

        if (missingChecks.length > 0) {
            core.warning("Some checks were not found, please check the workflow run summary to get the details");
            let missingChecksSummaryHeader = [{data: 'name', header: true}, {data: 'app.id', header: true}];
            let missingChecksSummary = missingChecks.map(check => {
                return [check.name, check.app_id.toString()]
            });

            await core.summary.addHeading("Missing Checks").addTable([

                missingChecksSummaryHeader,
                ...missingChecksSummary

            ]).write();

            // fail if the user wants us to fail on missing checks
            if (this.failOnMissingChecks) {
                core.setFailed("Failing due to missing checks");
            }
        }

    }


}
