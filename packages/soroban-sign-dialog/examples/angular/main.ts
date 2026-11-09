import '@angular/compiler';
import { AfterViewInit, Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, ViewChild, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { define, type ApproveDetail, type RejectDetail, type SorobanSignDialog } from '@theahaco/soroban-sign-dialog';
import { loadRequest, report } from '../shared.js';

define();
const request = await loadRequest();

@Component({
  selector: 'app-root',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <soroban-sign-dialog #dialog [transaction]="request.transaction" [network]="request.network" [signer]="request.signer"
      [labels]="request.labels" (approve)="onApprove($event)" (reject)="onReject($event)">
      <span slot="footer">Signed with Acme Wallet</span>
    </soroban-sign-dialog>`,
})
class AppComponent implements AfterViewInit {
  @ViewChild('dialog') dialog!: ElementRef<SorobanSignDialog>;
  request = request;

  ngAfterViewInit() {
    this.dialog.nativeElement.show();
  }

  onApprove(e: Event) {
    report(`approved:${(e as CustomEvent<ApproveDetail>).detail.entries.length}`);
  }

  onReject(e: Event) {
    report(`rejected:${(e as CustomEvent<RejectDetail>).detail.reason}`);
  }
}

bootstrapApplication(AppComponent, { providers: [provideZonelessChangeDetection()] });
